import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Schema } from 'effect';
import { Server } from './server.js';
import { Client } from './client.js';
import { CommitEvent, CommittedEvent } from './shared.js';

describe('Server-Client Integration', () => {
    let serverState: { counter: number };
    let clientState: { counter: number };
    let server: Server<any, any>;
    let client: Client<any, any>;

    const events = {
        increment: Schema.Number,
        decrement: Schema.Number,
        reset: Schema.Void,
    };

    const setupIntegration = () => {
        serverState = { counter: 0 };
        clientState = { counter: 0 };

        const serverMaterializers = {
            increment: (event: CommitEvent<'increment', Schema.Schema<number>>) => {
                serverState.counter += event.payload;
                return serverState.counter;
            },
            decrement: (event: CommitEvent<'decrement', Schema.Schema<number>>) => {
                if (serverState.counter - event.payload < 0) {
                    throw new Error('Cannot go below zero');
                }
                serverState.counter -= event.payload;
                return serverState.counter;
            },
            reset: () => {
                serverState.counter = 0;
                return serverState.counter;
            },
        };

        const clientMaterializers = {
            increment: {
                apply: (event: CommitEvent<'increment', Schema.Schema<number>>) => {
                    clientState.counter += event.payload;
                    return clientState.counter;
                },
                rollback: (event: CommitEvent<'increment', Schema.Schema<number>>) => {
                    clientState.counter -= event.payload;
                    return clientState.counter;
                },
            },
            decrement: {
                apply: (event: CommitEvent<'decrement', Schema.Schema<number>>) => {
                    clientState.counter -= event.payload;
                    return clientState.counter;
                },
                rollback: (event: CommitEvent<'decrement', Schema.Schema<number>>) => {
                    clientState.counter += event.payload;
                    return clientState.counter;
                },
            },
            reset: {
                apply: () => {
                    clientState.counter = 0;
                    return clientState.counter;
                },
                rollback: () => {
                    // For simplicity, assume reset can't be rolled back properly
                    return clientState.counter;
                },
            },
        };

        client = new Client({
            sequence: 0,
            events,
            materializers: clientMaterializers,
            onCommit: async event => {
                // Client sends committed events to server
                await server.commit(event);
            },
        });

        server = new Server({
            sequence: 0,
            events,
            materializers: serverMaterializers,
            onCommited: async event => {
                // Server sends committed events back to client
                await client.receive(event);
            },
        });
    };

    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('basic synchronization', () => {
        it('should synchronize single event between client and server', async () => {
            setupIntegration();

            await client.commit({ name: 'increment', payload: 5 });

            // Allow time for the round trip: client -> server -> client
            await new Promise(resolve => setTimeout(resolve, 200));

            expect(clientState.counter).toBe(5);
            expect(serverState.counter).toBe(5);
        });

        it('should synchronize multiple events', async () => {
            setupIntegration();

            await client.commit({ name: 'increment', payload: 3 });
            await client.commit({ name: 'increment', payload: 2 });
            await client.commit({ name: 'decrement', payload: 1 });

            await new Promise(resolve => setTimeout(resolve, 300));

            expect(clientState.counter).toBe(4);
            expect(serverState.counter).toBe(4);
        });

        it('should handle optimistic updates correctly', async () => {
            setupIntegration();

            // Client should immediately show optimistic update
            await client.commit({ name: 'increment', payload: 10 });

            // Before server processing, client should show optimistic state
            expect(clientState.counter).toBe(10);
            expect(serverState.counter).toBe(0);

            // After server processing
            await new Promise(resolve => setTimeout(resolve, 200));

            expect(clientState.counter).toBe(10);
            expect(serverState.counter).toBe(10);
        });
    });

    describe('error scenarios', () => {
        it('should handle server rejection with client rollback', async () => {
            setupIntegration();

            // First set a positive value
            await client.commit({ name: 'increment', payload: 3 });
            await new Promise(resolve => setTimeout(resolve, 200));

            expect(clientState.counter).toBe(3);
            expect(serverState.counter).toBe(3);

            // Try to decrement below zero (should fail on server)
            await client.commit({ name: 'decrement', payload: 5 });

            // Client should optimistically apply the change
            expect(clientState.counter).toBe(-2);

            // After server processing and rollback
            await new Promise(resolve => setTimeout(resolve, 200));

            // Client should have rolled back
            expect(clientState.counter).toBe(3);
            expect(serverState.counter).toBe(3);
        });

        it('should handle multiple pending events with mixed success/failure', async () => {
            setupIntegration();

            // Submit multiple events rapidly
            await client.commit({ name: 'increment', payload: 5 });
            await client.commit({ name: 'increment', payload: 3 });
            await client.commit({ name: 'decrement', payload: 10 }); // This should fail
            await client.commit({ name: 'increment', payload: 2 });

            // Client should show optimistic updates
            expect(clientState.counter).toBe(0); // 5 + 3 - 10 + 2

            await new Promise(resolve => setTimeout(resolve, 400));

            // After server processing, the failing event should be rolled back
            expect(clientState.counter).toBe(10); // 5 + 3 + 2 (decrement 10 failed)
            expect(serverState.counter).toBe(10);
        });
    });

    describe('concurrent operations', () => {
        it('should handle concurrent client commits', async () => {
            setupIntegration();

            const promises = [
                client.commit({ name: 'increment', payload: 1 }),
                client.commit({ name: 'increment', payload: 2 }),
                client.commit({ name: 'increment', payload: 3 }),
                client.commit({ name: 'increment', payload: 4 }),
                client.commit({ name: 'increment', payload: 5 }),
            ];

            await Promise.all(promises);
            await new Promise(resolve => setTimeout(resolve, 400));

            expect(clientState.counter).toBe(15);
            expect(serverState.counter).toBe(15);
        });

        it('should maintain event ordering in concurrent scenarios', async () => {
            setupIntegration();

            const processingOrder: number[] = [];

            // Override server materializer to track processing order
            const originalMaterializer = server as any;
            const trackingServer = new Server({
                sequence: 0,
                events,
                materializers: {
                    increment: (event: CommitEvent<'increment', Schema.Schema<number>>) => {
                        processingOrder.push(event.payload);
                        serverState.counter += event.payload;
                        return serverState.counter;
                    },
                    decrement: (event: CommitEvent<'decrement', Schema.Schema<number>>) => {
                        processingOrder.push(-event.payload);
                        if (serverState.counter - event.payload < 0) {
                            throw new Error('Cannot go below zero');
                        }
                        serverState.counter -= event.payload;
                        return serverState.counter;
                    },
                    reset: () => {
                        processingOrder.push(0);
                        serverState.counter = 0;
                        return serverState.counter;
                    },
                },
                onCommited: async event => {
                    await client.receive(event);
                },
            });

            // Update client to use the tracking server
            const trackingClient = new Client({
                sequence: 0,
                events,
                materializers: {
                    increment: {
                        apply: (event: CommitEvent<'increment', Schema.Schema<number>>) => {
                            clientState.counter += event.payload;
                            return clientState.counter;
                        },
                        rollback: (event: CommitEvent<'increment', Schema.Schema<number>>) => {
                            clientState.counter -= event.payload;
                            return clientState.counter;
                        },
                    },
                    decrement: {
                        apply: (event: CommitEvent<'decrement', Schema.Schema<number>>) => {
                            clientState.counter -= event.payload;
                            return clientState.counter;
                        },
                        rollback: (event: CommitEvent<'decrement', Schema.Schema<number>>) => {
                            clientState.counter += event.payload;
                            return clientState.counter;
                        },
                    },
                    reset: {
                        apply: () => {
                            clientState.counter = 0;
                            return clientState.counter;
                        },
                        rollback: () => {
                            return clientState.counter;
                        },
                    },
                },
                onCommit: async event => {
                    await trackingServer.commit(event);
                },
            });

            // Submit events concurrently
            await Promise.all([
                trackingClient.commit({ name: 'increment', payload: 1 }),
                trackingClient.commit({ name: 'increment', payload: 2 }),
                trackingClient.commit({ name: 'increment', payload: 3 }),
            ]);

            await new Promise(resolve => setTimeout(resolve, 300));

            // Events should be processed in the order they were submitted
            expect(processingOrder).toEqual([1, 2, 3]);
            expect(clientState.counter).toBe(6);
            expect(serverState.counter).toBe(6);
        });
    });

    describe('complex scenarios', () => {
        it('should handle reset operations correctly', async () => {
            setupIntegration();

            await client.commit({ name: 'increment', payload: 10 });
            await client.commit({ name: 'increment', payload: 5 });
            await new Promise(resolve => setTimeout(resolve, 200));

            expect(clientState.counter).toBe(15);
            expect(serverState.counter).toBe(15);

            await client.commit({ name: 'reset', payload: undefined });
            await new Promise(resolve => setTimeout(resolve, 200));

            expect(clientState.counter).toBe(0);
            expect(serverState.counter).toBe(0);
        });

        it('should handle rapid increment/decrement patterns', async () => {
            setupIntegration();

            // Rapid alternating pattern
            for (let i = 0; i < 5; i++) {
                await client.commit({ name: 'increment', payload: 2 });
                await client.commit({ name: 'decrement', payload: 1 });
            }

            await new Promise(resolve => setTimeout(resolve, 400));

            expect(clientState.counter).toBe(5); // (2-1) * 5
            expect(serverState.counter).toBe(5);
        });

        it('should handle events with different payload types', async () => {
            const complexEvents = {
                setNumber: Schema.Number,
                setText: Schema.String,
                setBoolean: Schema.Boolean,
            };

            let serverData: any = {};
            let clientData: any = {};

            const complexServer = new Server({
                sequence: 0,
                events: complexEvents,
                materializers: {
                    setNumber: (event: any) => {
                        serverData.number = event.payload;
                    },
                    setText: (event: any) => {
                        serverData.text = event.payload;
                    },
                    setBoolean: (event: any) => {
                        serverData.boolean = event.payload;
                    },
                },
                onCommited: async event => {
                    await complexClient.receive(event);
                },
            });

            const complexClient = new Client({
                sequence: 0,
                events: complexEvents,
                materializers: {
                    setNumber: {
                        apply: (event: any) => {
                            clientData.number = event.payload;
                        },
                        rollback: (event: any) => {
                            delete clientData.number;
                        },
                    },
                    setText: {
                        apply: (event: any) => {
                            clientData.text = event.payload;
                        },
                        rollback: (event: any) => {
                            delete clientData.text;
                        },
                    },
                    setBoolean: {
                        apply: (event: any) => {
                            clientData.boolean = event.payload;
                        },
                        rollback: (event: any) => {
                            delete clientData.boolean;
                        },
                    },
                },
                onCommit: async event => {
                    await complexServer.commit(event);
                },
            });

            await complexClient.commit({ name: 'setNumber', payload: 42 });
            await complexClient.commit({ name: 'setText', payload: 'hello' });
            await complexClient.commit({ name: 'setBoolean', payload: true });

            await new Promise(resolve => setTimeout(resolve, 300));

            expect(clientData).toEqual({
                number: 42,
                text: 'hello',
                boolean: true,
            });
            expect(serverData).toEqual({
                number: 42,
                text: 'hello',
                boolean: true,
            });
        });
    });

    describe('real-world simulation', () => {
        it('should simulate a collaborative counter application', async () => {
            setupIntegration();

            // Simulate multiple users (clients) by having the same client make different types of operations
            const userActions = [
                { action: 'increment', value: 5, user: 'Alice' },
                { action: 'increment', value: 3, user: 'Bob' },
                { action: 'decrement', value: 2, user: 'Alice' },
                { action: 'increment', value: 7, user: 'Charlie' },
                { action: 'decrement', value: 1, user: 'Bob' },
            ];

            // Execute all actions
            for (const userAction of userActions) {
                if (userAction.action === 'increment') {
                    await client.commit({ name: 'increment', payload: userAction.value });
                } else {
                    await client.commit({ name: 'decrement', payload: userAction.value });
                }
            }

            await new Promise(resolve => setTimeout(resolve, 400));

            const expectedValue = 5 + 3 - 2 + 7 - 1; // 12
            expect(clientState.counter).toBe(expectedValue);
            expect(serverState.counter).toBe(expectedValue);
        });

        it('should handle network-like delays and out-of-order processing', async () => {
            setupIntegration();

            // Simulate network delays by adding random delays to server processing
            const delayedServer = new Server({
                sequence: 0,
                events,
                materializers: {
                    increment: async (event: CommitEvent<'increment', Schema.Schema<number>>) => {
                        // Random delay to simulate network latency
                        await new Promise(resolve => setTimeout(resolve, Math.random() * 50));
                        serverState.counter += event.payload;
                        return serverState.counter;
                    },
                    decrement: async (event: CommitEvent<'decrement', Schema.Schema<number>>) => {
                        await new Promise(resolve => setTimeout(resolve, Math.random() * 50));
                        if (serverState.counter - event.payload < 0) {
                            throw new Error('Cannot go below zero');
                        }
                        serverState.counter -= event.payload;
                        return serverState.counter;
                    },
                    reset: async () => {
                        await new Promise(resolve => setTimeout(resolve, Math.random() * 50));
                        serverState.counter = 0;
                        return serverState.counter;
                    },
                },
                onCommited: async event => {
                    // Add delay to simulate network round-trip
                    await new Promise(resolve => setTimeout(resolve, Math.random() * 30));
                    await client.receive(event);
                },
            });

            const delayedClient = new Client({
                sequence: 0,
                events,
                materializers: {
                    increment: {
                        apply: (event: CommitEvent<'increment', Schema.Schema<number>>) => {
                            clientState.counter += event.payload;
                            return clientState.counter;
                        },
                        rollback: (event: CommitEvent<'increment', Schema.Schema<number>>) => {
                            clientState.counter -= event.payload;
                            return clientState.counter;
                        },
                    },
                    decrement: {
                        apply: (event: CommitEvent<'decrement', Schema.Schema<number>>) => {
                            clientState.counter -= event.payload;
                            return clientState.counter;
                        },
                        rollback: (event: CommitEvent<'decrement', Schema.Schema<number>>) => {
                            clientState.counter += event.payload;
                            return clientState.counter;
                        },
                    },
                    reset: {
                        apply: () => {
                            clientState.counter = 0;
                            return clientState.counter;
                        },
                        rollback: () => {
                            return clientState.counter;
                        },
                    },
                },
                onCommit: async event => {
                    await delayedServer.commit(event);
                },
            });

            // Submit multiple operations rapidly
            await Promise.all([
                delayedClient.commit({ name: 'increment', payload: 1 }),
                delayedClient.commit({ name: 'increment', payload: 2 }),
                delayedClient.commit({ name: 'increment', payload: 3 }),
                delayedClient.commit({ name: 'increment', payload: 4 }),
                delayedClient.commit({ name: 'increment', payload: 5 }),
            ]);

            // Allow extra time for all delayed operations to complete
            await new Promise(resolve => setTimeout(resolve, 800));

            expect(clientState.counter).toBe(15);
            expect(serverState.counter).toBe(15);
        });
    });
});
