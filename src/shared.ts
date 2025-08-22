import { Schema } from 'effect';
import { customAlphabet } from 'nanoid';

export const nanoid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 5);

export type Events = Record<string, Schema.Schema<any>>;

export type CommitEvent<TName extends string | number | symbol, TPayloadSchema> = {
    name: string & TName;
    payload: Schema.Schema.Type<TPayloadSchema>;
    clientId?: string;
    error?: boolean;
};

export type CommittedEvent<TName extends string | number | symbol, TPayloadSchema> = {
    name: string & TName;
    payload: Schema.Schema.Type<TPayloadSchema>;
    clientId?: string;
    error?: boolean;
    sequence: number;
};

export const schemaFromEvents = (events: Events) => {
    return Schema.Union(
        ...Object.keys(events).map(key =>
            Schema.Struct({
                name: Schema.Literal(key),
                payload: events[key],
                clientId: Schema.optionalWith(Schema.String, {}),
            })
        )
    );
};
