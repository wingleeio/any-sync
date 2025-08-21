import { Effect, Queue, Schema, Context, Data, Layer, ManagedRuntime, Ref, Schedule } from 'effect';
import { Events, CommitEvent, schemaFromEvents, CommittedEvent } from './shared.js';

export type ServerMaterializers<TEvents extends Events> = {
    [K in keyof TEvents]: (event: CommitEvent<K, TEvents[K]>) => Promise<any> | any;
};

export type ServerContext<
    TEvents extends Events,
    TMaterializers extends ServerMaterializers<TEvents>
> = {
    sequence: Ref.Ref<number>;
    status: Ref.Ref<'idle' | 'processing'>;
    queue: Queue.Queue<CommitEvent<keyof TEvents, TEvents[keyof TEvents]>>;
    schema: Schema.Schema<{ readonly name: string; readonly payload: any }>;
    materializers: TMaterializers;
};

export type ServerRuntime<
    TEvents extends Events,
    TMaterializers extends ServerMaterializers<TEvents>
> = ManagedRuntime.ManagedRuntime<
    ServerContext<TEvents, TMaterializers>,
    ServerContext<TEvents, TMaterializers>
>;

export const ServerContext = <
    TEvents extends Events,
    TMaterializers extends ServerMaterializers<TEvents>
>() => {
    return Context.GenericTag<{
        sequence: Ref.Ref<number>;
        status: Ref.Ref<'idle' | 'processing'>;
        queue: Queue.Queue<CommitEvent<keyof TEvents, TEvents[keyof TEvents]>>;
        schema: Schema.Schema<{ readonly name: string; readonly payload: any }>;
        materializers: TMaterializers;
    }>(`ServerContext`);
};

export type ServerOptions<
    TEvents extends Events,
    TMaterializers extends ServerMaterializers<TEvents>
> = {
    sequence: number;
    events: TEvents;
    materializers: TMaterializers;
    onCommited?: (
        event: CommittedEvent<keyof TEvents, TEvents[keyof TEvents]>
    ) => Promise<void> | void;
};

export class Server<TEvents extends Events, TMaterializers extends ServerMaterializers<TEvents>> {
    private readonly runtime: ServerRuntime<TEvents, TMaterializers>;
    private readonly context = ServerContext<TEvents, TMaterializers>();
    private readonly onCommited?: (
        event: CommittedEvent<keyof TEvents, TEvents[keyof TEvents]>
    ) => Promise<void> | void;

    constructor(options: ServerOptions<TEvents, TMaterializers>) {
        const layer = Layer.scoped(
            this.context,
            Effect.Do.pipe(
                Effect.bind('queue', () =>
                    Queue.unbounded<CommitEvent<keyof TEvents, TEvents[keyof TEvents]>>()
                ),
                Effect.bind('sequence', () => Ref.make(options.sequence)),
                Effect.bind('status', () => Ref.make<'idle' | 'processing'>('idle')),
                Effect.let('schema', () => schemaFromEvents(options.events)),
                Effect.let('materializers', () => options.materializers)
            )
        );

        this.runtime = ManagedRuntime.make(layer);
        this.onCommited = options.onCommited;
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

    private process() {
        const self = this;
        const drain = Effect.gen(function* () {
            const ctx = yield* self.context;
            const event = yield* Queue.take(ctx.queue);

            const materializer = ctx.materializers[event.name];

            yield* Effect.tryPromise(() => Promise.resolve(materializer(event as any))).pipe(
                Effect.tapError(() =>
                    Effect.tryPromise(() =>
                        Promise.resolve(self?.onCommited?.({ ...event, sequence: -1, error: true }))
                    )
                ),
                Effect.catchAll(e => new MaterializerError({ event, error: e.error }))
            );

            const sequence = yield* Ref.get(ctx.sequence);

            yield* Effect.tryPromise(() =>
                Promise.resolve(self?.onCommited?.({ ...event, sequence }))
            ).pipe(Effect.catchAll(e => new CommitError({ event, error: e.error })));

            yield* Ref.set(ctx.sequence, sequence + 1);
        });

        return drain.pipe(
            Effect.catchAll(e => Effect.logWarning('Server: Error processing event', e)),
            Effect.repeat(Schedule.forever)
        );
    }
}

export class CommitError extends Data.TaggedError('CommitError')<{
    readonly event: CommitEvent<any, any>;
    readonly error: unknown;
}> {}

export class MaterializerError extends Data.TaggedError('MaterializerError')<{
    readonly event: CommitEvent<any, any>;
    readonly error: unknown;
}> {}
