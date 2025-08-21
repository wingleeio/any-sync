import { Context, Effect, Layer, ManagedRuntime, Queue, Ref, Schedule, Schema } from 'effect';
import { CommitEvent, CommittedEvent, Events, nanoid, schemaFromEvents } from './shared.js';

export type ClientMaterializers<TEvents extends Events> = {
    [K in keyof TEvents]: {
        apply: (event: CommitEvent<K, TEvents[K]>) => Promise<any> | any;
        rollback: (event: CommitEvent<K, TEvents[K]>) => Promise<any> | any;
    };
};

export type ClientPendingEvents<TEvents extends Events> = Record<
    string,
    CommitEvent<keyof TEvents, TEvents[keyof TEvents]>
>;

export type ClientContext<
    TEvents extends Events,
    TMaterializers extends ClientMaterializers<TEvents>
> = {
    pending: Ref.Ref<ClientPendingEvents<TEvents>>;
    sequence: Ref.Ref<number>;
    status: Ref.Ref<'idle' | 'processing'>;
    queue: Queue.Queue<CommitEvent<keyof TEvents, TEvents[keyof TEvents]>>;
    schema: Schema.Schema<{ readonly name: string; readonly payload: any }>;
    materializers: TMaterializers;
};

export const ClientContext = <
    TEvents extends Events,
    TMaterializers extends ClientMaterializers<TEvents>
>() => {
    return Context.GenericTag<{
        pending: Ref.Ref<ClientPendingEvents<TEvents>>;
        sequence: Ref.Ref<number>;
        status: Ref.Ref<'idle' | 'processing'>;
        queue: Queue.Queue<CommitEvent<keyof TEvents, TEvents[keyof TEvents]>>;
        schema: Schema.Schema<{ readonly name: string; readonly payload: any }>;
        materializers: TMaterializers;
    }>(`ServerContext`);
};

export type ClientRuntime<
    TEvents extends Events,
    TMaterializers extends ClientMaterializers<TEvents>
> = ManagedRuntime.ManagedRuntime<
    ClientContext<TEvents, TMaterializers>,
    ClientContext<TEvents, TMaterializers>
>;

export type ClientOptions<
    TEvents extends Events,
    TMaterializers extends ClientMaterializers<TEvents>
> = {
    sequence: number;
    events: TEvents;
    materializers: TMaterializers;
    onCommit?: (
        event: CommittedEvent<keyof TEvents, TEvents[keyof TEvents]>
    ) => Promise<void> | void;
};

export class Client<TEvents extends Events, TMaterializers extends ClientMaterializers<TEvents>> {
    private readonly runtime: ClientRuntime<TEvents, ClientMaterializers<TEvents>>;
    private readonly context = ClientContext<TEvents, ClientMaterializers<TEvents>>();
    private readonly onCommit?: (
        event: CommittedEvent<keyof TEvents, TEvents[keyof TEvents]>
    ) => Promise<void> | void;

    constructor(options: ClientOptions<TEvents, TMaterializers>) {
        const layer = Layer.scoped(
            this.context,
            Effect.Do.pipe(
                Effect.bind('pending', () => Ref.make<ClientPendingEvents<TEvents>>({})),
                Effect.bind('sequence', () => Ref.make(options.sequence)),
                Effect.bind('status', () => Ref.make<'idle' | 'processing'>('idle')),
                Effect.bind('queue', () =>
                    Queue.unbounded<CommitEvent<keyof TEvents, TEvents[keyof TEvents]>>()
                ),
                Effect.let('schema', () => schemaFromEvents(options.events)),
                Effect.let('materializers', () => options.materializers)
            )
        );

        this.runtime = ManagedRuntime.make(layer);

        this.onCommit = options.onCommit;
    }

    public commit<K extends keyof TEvents>(event: CommitEvent<K, TEvents[K]>) {
        const self = this;
        return this.runtime.runPromise(
            Effect.gen(function* () {
                const ctx = yield* self.context;
                const validatedEvent = yield* Schema.decode(ctx.schema)(event);

                yield* Queue.offer(ctx.queue, validatedEvent);

                const status = yield* Ref.get(ctx.status);

                if (status === 'processing') {
                    return;
                }

                yield* Ref.set(ctx.status, 'processing');
                yield* Effect.forkDaemon(self.process());
            })
        );
    }

    public receive<K extends keyof TEvents>(event: CommittedEvent<K, TEvents[K]>) {
        const self = this;
        return this.runtime.runPromise(
            Effect.gen(function* () {
                const ctx = yield* self.context;
                const pending = yield* Ref.get(ctx.pending);

                if (event.clientId && pending[event.clientId]) {
                    if (event.error) {
                        const materializer = ctx.materializers[event.name].rollback;

                        yield* Effect.tryPromise(() => Promise.resolve(materializer(event as any)));

                        yield* Ref.update(ctx.pending, ({ [event.clientId!]: _, ...rest }) => rest);
                    }

                    yield* Ref.update(ctx.pending, ({ [event.clientId!]: _, ...rest }) => rest);
                    return;
                }

                if (event.error) {
                    return;
                }

                const materializer = ctx.materializers[event.name].apply;

                yield* Effect.tryPromise(() => Promise.resolve(materializer(event as any)));
            })
        );
    }

    private process() {
        const self = this;
        const drain = Effect.gen(function* () {
            const ctx = yield* self.context;
            const event = yield* Queue.take(ctx.queue);
            const clientId = nanoid();

            const materializer = ctx.materializers[event.name].apply;

            const clientEvent = {
                ...event,
                clientId,
            };

            yield* Effect.tryPromise(() => Promise.resolve(materializer(clientEvent as any)));

            yield* Ref.update(ctx.pending, pending => ({
                ...pending,
                [clientId]: clientEvent,
            }));

            yield* Effect.promise(() => Promise.resolve(self.onCommit?.(clientEvent as any)));
        });

        return drain.pipe(
            Effect.catchAll(e => Effect.logWarning('Client: Error processing event', e)),
            Effect.repeat(Schedule.forever)
        );
    }
}
