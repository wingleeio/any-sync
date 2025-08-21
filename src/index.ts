export * as Server from './server.js';
export * as Client from './client.js';
import { Server } from './server.js';
import { Client } from './client.js';
import { Schema } from 'effect';

const serverState = {
    state: 0,
};

const events = {
    add: Schema.Number,
    sub: Schema.Number,
};

const server = new Server({
    sequence: 0,
    events,
    materializers: {
        add: event => (serverState.state += event.payload),
        sub: event => {
            if (serverState.state === 0 || serverState.state - event.payload < 0) {
                throw new Error('Subtraction is not allowed');
            }

            return (serverState.state -= event.payload);
        },
    },
    onCommited: async event => {
        console.log('Server: onCommited', event);
        client.receive(event);
    },
});

const clientState = {
    state: 0,
};

const client = new Client({
    events,
    sequence: 0,
    materializers: {
        add: {
            apply: event => (clientState.state += event.payload),
            rollback: event => (clientState.state -= event.payload),
        },
        sub: {
            apply: event => (clientState.state -= event.payload),
            rollback: event => (clientState.state += event.payload),
        },
    },
    onCommit: async event => {
        server.commit(event);
        console.log('ClientState', clientState);
    },
});
