import { Effect, Queue, Schema, Context, Layer, ManagedRuntime } from 'effect';

type Events = Record<string, Schema.Schema<any>>;

const schemaFromEvents = (events: Events) => {
    return Schema.Union(
        ...Object.keys(events).map(key =>
            Schema.Struct({
                name: Schema.Literal(key),
                payload: events[key],
            })
        )
    );
};

type ServerMaterializers<TEvents extends Events> = {
    [K in keyof TEvents]: (event: TEvents[K]) => void;
};

type ServerOptions<TEvents extends Events, TMaterializers extends ServerMaterializers<TEvents>> = {
    events: TEvents;
    materializers: TMaterializers;
};

type ServerRuntimeIn<
    TEvents extends Events,
    TMaterializers extends ServerMaterializers<TEvents>
> = {
    queue: Queue.Queue<TEvents>;
    schema: Schema.Schema<{ readonly name: string; readonly payload: any }>;
    materializers: TMaterializers;
};

type ServerRuntimeOut<
    TEvents extends Events,
    TMaterializers extends ServerMaterializers<TEvents>
> = {
    queue: Queue.Queue<TEvents>;
    schema: Schema.Schema<{ readonly name: string; readonly payload: any }>;
    materializers: TMaterializers;
};

type ServerRuntime<
    TEvents extends Events,
    TMaterializers extends ServerMaterializers<TEvents>
> = ManagedRuntime.ManagedRuntime<
    ServerRuntimeIn<TEvents, TMaterializers>,
    ServerRuntimeOut<TEvents, TMaterializers>
>;

const ServerContext = <
    TEvents extends Events,
    TMaterializers extends ServerMaterializers<TEvents>
>() => {
    return Context.GenericTag<{
        queue: Queue.Queue<TEvents>;
        schema: Schema.Schema<{ readonly name: string; readonly payload: any }>;
        materializers: TMaterializers;
    }>(`ServerContext`);
};

class Server<TEvents extends Events, TMaterializers extends ServerMaterializers<TEvents>> {
    private readonly runtime: ServerRuntime<TEvents, TMaterializers>;
    private readonly context = ServerContext<TEvents, TMaterializers>();

    constructor(options: ServerOptions<TEvents, TMaterializers>) {
        const layer = Layer.scoped(
            this.context,
            Effect.Do.pipe(
                Effect.bind('queue', () => Queue.bounded<TEvents>(1)),
                Effect.let('schema', () => schemaFromEvents(options.events)),
                Effect.let('materializers', () => options.materializers)
            )
        );

        this.runtime = ManagedRuntime.make(layer);
    }
}
