import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Schema } from 'effect';
import { Client, ClientOptions } from './client.js';
import { CommitEvent, CommittedEvent } from './shared.js';

describe('Client', () => {
    let mockState: { value: number };
    let onCommitSpy: ReturnType<typeof vi.fn>;
    let applySpy: ReturnType<typeof vi.fn>;
    let rollbackSpy: ReturnType<typeof vi.fn>;

    const events = {
        increment: Schema.Number,
        decrement: Schema.Number,
        multiply: Schema.Number,
        reset: Schema.Void,
    };

    const createClient = (overrides: Partial<ClientOptions<typeof events, any>> = {}) => {
        mockState = { value: 0 };
        onCommitSpy = vi.fn();
        applySpy = vi.fn();
        rollbackSpy = vi.fn();

        const materializers = {
            increment: {
                apply: (event: CommitEvent<'increment', Schema.Schema<number>>) => {
                    applySpy('increment', event.payload);
                    mockState.value += event.payload;
                    return mockState.value;
                },
                rollback: (event: CommitEvent<'increment', Schema.Schema<number>>) => {
                    rollbackSpy('increment', event.payload);
                    mockState.value -= event.payload;
                    return mockState.value;
                },
            },
            decrement: {
                apply: (event: CommitEvent<'decrement', Schema.Schema<number>>) => {
                    applySpy('decrement', event.payload);
                    if (mockState.value - event.payload < 0) {
                        throw new Error('Cannot go below zero');
                    }
                    mockState.value -= event.payload;
                    return mockState.value;
                },
                rollback: (event: CommitEvent<'decrement', Schema.Schema<number>>) => {
                    rollbackSpy('decrement', event.payload);
                    mockState.value += event.payload;
                    return mockState.value;
                },
            },
            multiply: {
                apply: (event: CommitEvent<'multiply', Schema.Schema<number>>) => {
                    applySpy('multiply', event.payload);
                    mockState.value *= event.payload;
                    return mockState.value;
                },
                rollback: (event: CommitEvent<'multiply', Schema.Schema<number>>) => {
                    rollbackSpy('multiply', event.payload);
                    // Reverse multiplication by dividing (assuming payload != 0)
                    if (event.payload !== 0) {
                        mockState.value /= event.payload;
                    }
                    return mockState.value;
                },
            },
            reset: {
                apply: () => {
                    applySpy('reset');
                    const previousValue = mockState.value;
                    mockState.value = 0;
                    return previousValue;
                },
                rollback: (event: any) => {
                    rollbackSpy('reset');
                    // For rollback, we'd need to store the previous value
                    // This is a simplified example
                    mockState.value = event.previousValue || 0;
                    return mockState.value;
                },
            },
        };

        return new Client({
            sequence: 0,
            events,
            materializers,
            onCommit: onCommitSpy,
            ...overrides,
        });
    };

    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('basic functionality', () => {
        it('should create client instance', () => {
            const client = createClient();
            expect(client).toBeInstanceOf(Client);
        });

        it('should apply and commit single event', async () => {
            const client = createClient();

            await client.commit({ name: 'increment', payload: 5 });

            await new Promise(resolve => setTimeout(resolve, 100));

            expect(mockState.value).toBe(5);
            expect(applySpy).toHaveBeenCalledWith('increment', 5);
            expect(onCommitSpy).toHaveBeenCalledTimes(1);

            const commitCall = onCommitSpy.mock.calls[0][0];
            expect(commitCall.name).toBe('increment');
            expect(commitCall.payload).toBe(5);
            expect(commitCall.clientId).toBeDefined();
        });

        it('should process multiple commits in sequence', async () => {
            const client = createClient();

            await client.commit({ name: 'increment', payload: 5 });
            await client.commit({ name: 'increment', payload: 3 });
            await client.commit({ name: 'decrement', payload: 2 });

            await new Promise(resolve => setTimeout(resolve, 200));

            expect(mockState.value).toBe(6);
            expect(applySpy).toHaveBeenCalledTimes(3);
            expect(onCommitSpy).toHaveBeenCalledTimes(3);
        });

        it('should handle void payloads', async () => {
            const client = createClient();

            await client.commit({ name: 'increment', payload: 10 });
            await client.commit({ name: 'reset', payload: undefined });

            await new Promise(resolve => setTimeout(resolve, 200));

            expect(mockState.value).toBe(0);
            expect(applySpy).toHaveBeenCalledWith('reset');
        });

        it('should work without onCommit callback', async () => {
            const client = createClient({ onCommit: undefined });

            await client.commit({ name: 'increment', payload: 5 });

            await new Promise(resolve => setTimeout(resolve, 100));

            expect(mockState.value).toBe(5);
            expect(applySpy).toHaveBeenCalledWith('increment', 5);
        });
    });

    describe('receive functionality', () => {
        it('should apply events from server when not in pending', async () => {
            const client = createClient();

            const serverEvent: CommittedEvent<'increment', Schema.Schema<number>> = {
                name: 'increment',
                payload: 7,
                sequence: 0,
            };

            await client.receive(serverEvent);

            expect(mockState.value).toBe(7);
            expect(applySpy).toHaveBeenCalledWith('increment', 7);
        });

        it('should ignore error events from server when not pending', async () => {
            const client = createClient();

            const serverEvent: CommittedEvent<'increment', Schema.Schema<number>> = {
                name: 'increment',
                payload: 7,
                sequence: 0,
                error: true,
            };

            await client.receive(serverEvent);

            expect(mockState.value).toBe(0);
            expect(applySpy).not.toHaveBeenCalled();
        });

        it('should handle pending event confirmation', async () => {
            const client = createClient();

            // First commit an event to make it pending
            await client.commit({ name: 'increment', payload: 5 });
            await new Promise(resolve => setTimeout(resolve, 50));

            const commitCall = onCommitSpy.mock.calls[0][0];
            const clientId = commitCall.clientId;

            // Now simulate server confirming this event
            const serverEvent: CommittedEvent<'increment', Schema.Schema<number>> = {
                name: 'increment',
                payload: 5,
                sequence: 0,
                clientId,
            };

            await client.receive(serverEvent);

            // Should not apply again (already applied during commit)
            expect(applySpy).toHaveBeenCalledTimes(1);
            expect(mockState.value).toBe(5);
        });

        it('should rollback pending event on server error', async () => {
            const client = createClient();

            // First commit an event to make it pending
            await client.commit({ name: 'increment', payload: 5 });
            await new Promise(resolve => setTimeout(resolve, 50));

            const commitCall = onCommitSpy.mock.calls[0][0];
            const clientId = commitCall.clientId;

            // Now simulate server rejecting this event
            const serverEvent: CommittedEvent<'increment', Schema.Schema<number>> = {
                name: 'increment',
                payload: 5,
                sequence: -1,
                error: true,
                clientId,
            };

            await client.receive(serverEvent);

            // Should have rolled back
            expect(rollbackSpy).toHaveBeenCalledWith('increment', 5);
            expect(mockState.value).toBe(0);
        });

        it('should handle multiple pending events', async () => {
            const client = createClient();

            // Commit multiple events
            await client.commit({ name: 'increment', payload: 3 });
            await client.commit({ name: 'increment', payload: 4 });
            await client.commit({ name: 'increment', payload: 5 });

            await new Promise(resolve => setTimeout(resolve, 100));

            const clientIds = onCommitSpy.mock.calls.map(call => call[0].clientId);

            // Confirm middle event
            const serverEvent: CommittedEvent<'increment', Schema.Schema<number>> = {
                name: 'increment',
                payload: 4,
                sequence: 1,
                clientId: clientIds[1],
            };

            await client.receive(serverEvent);

            expect(mockState.value).toBe(12); // 3 + 4 + 5
            expect(applySpy).toHaveBeenCalledTimes(3); // No additional applies
        });
    });

    describe('error handling', () => {
        it('should handle materializer apply errors during commit', async () => {
            const client = createClient();

            // This should fail because we can't go below zero
            await client.commit({ name: 'decrement', payload: 5 });

            await new Promise(resolve => setTimeout(resolve, 100));

            expect(mockState.value).toBe(0); // State should not change
            expect(applySpy).toHaveBeenCalledWith('decrement', 5);
            // onCommit should not be called for failed materializer
            expect(onCommitSpy).not.toHaveBeenCalled();
        });

        it('should handle async materializer errors', async () => {
            const asyncMaterializers = {
                increment: {
                    apply: async () => {
                        await new Promise(resolve => setTimeout(resolve, 10));
                        throw new Error('Async apply error');
                    },
                    rollback: async () => {
                        await new Promise(resolve => setTimeout(resolve, 10));
                    },
                },
                decrement: { apply: () => {}, rollback: () => {} },
                multiply: { apply: () => {}, rollback: () => {} },
                reset: { apply: () => {}, rollback: () => {} },
            };

            const client = new Client({
                sequence: 0,
                events,
                materializers: asyncMaterializers,
                onCommit: onCommitSpy,
            });

            await client.commit({ name: 'increment', payload: 5 });

            await new Promise(resolve => setTimeout(resolve, 100));

            expect(onCommitSpy).not.toHaveBeenCalled();
        });

        it('should handle rollback errors gracefully', async () => {
            const failingMaterializers = {
                increment: {
                    apply: (event: CommitEvent<'increment', Schema.Schema<number>>) => {
                        mockState.value += event.payload;
                    },
                    rollback: () => {
                        throw new Error('Rollback failed');
                    },
                },
                decrement: { apply: () => {}, rollback: () => {} },
                multiply: { apply: () => {}, rollback: () => {} },
                reset: { apply: () => {}, rollback: () => {} },
            };

            const client = new Client({
                sequence: 0,
                events,
                materializers: failingMaterializers,
                onCommit: onCommitSpy,
            });

            await client.commit({ name: 'increment', payload: 5 });
            await new Promise(resolve => setTimeout(resolve, 50));

            const commitCall = onCommitSpy.mock.calls[0][0];
            const clientId = commitCall.clientId;

            // Simulate server error
            const serverEvent: CommittedEvent<'increment', Schema.Schema<number>> = {
                name: 'increment',
                payload: 5,
                sequence: -1,
                error: true,
                clientId,
            };

            // Should not throw despite rollback error
            await expect(client.receive(serverEvent)).resolves.toBeUndefined();
        });

        it('should handle invalid event schema in commit', async () => {
            const client = createClient();

            await expect(
                client.commit({ name: 'increment', payload: 'invalid' } as any)
            ).rejects.toThrow();
        });

        it('should handle unknown event names in commit', async () => {
            const client = createClient();

            await expect(client.commit({ name: 'unknown', payload: 5 } as any)).rejects.toThrow();
        });
    });

    describe('concurrent operations', () => {
        it('should handle concurrent commits', async () => {
            const client = createClient();

            const promises = [
                client.commit({ name: 'increment', payload: 1 }),
                client.commit({ name: 'increment', payload: 2 }),
                client.commit({ name: 'increment', payload: 3 }),
                client.commit({ name: 'increment', payload: 4 }),
                client.commit({ name: 'increment', payload: 5 }),
            ];

            await Promise.all(promises);
            await new Promise(resolve => setTimeout(resolve, 200));

            expect(mockState.value).toBe(15);
            expect(applySpy).toHaveBeenCalledTimes(5);
            expect(onCommitSpy).toHaveBeenCalledTimes(5);
        });

        it('should handle concurrent receive operations', async () => {
            const client = createClient();

            const serverEvents = [
                { name: 'increment', payload: 1, sequence: 0 },
                { name: 'increment', payload: 2, sequence: 1 },
                { name: 'increment', payload: 3, sequence: 2 },
            ] as CommittedEvent<'increment', Schema.Schema<number>>[];

            const promises = serverEvents.map(event => client.receive(event));
            await Promise.all(promises);

            expect(mockState.value).toBe(6);
            expect(applySpy).toHaveBeenCalledTimes(3);
        });

        it('should handle mixed commit and receive operations', async () => {
            const client = createClient();

            const operations = [
                () => client.commit({ name: 'increment', payload: 1 }),
                () => client.receive({ name: 'increment', payload: 2, sequence: 0 }),
                () => client.commit({ name: 'increment', payload: 3 }),
                () => client.receive({ name: 'increment', payload: 4, sequence: 1 }),
            ];

            await Promise.all(operations.map(op => op()));
            await new Promise(resolve => setTimeout(resolve, 200));

            expect(mockState.value).toBe(10);
            expect(applySpy).toHaveBeenCalledTimes(4);
        });
    });

    describe('edge cases', () => {
        it('should handle zero values correctly', async () => {
            const client = createClient();

            await client.commit({ name: 'increment', payload: 0 });
            await client.receive({ name: 'increment', payload: 0, sequence: 0 });

            await new Promise(resolve => setTimeout(resolve, 100));

            expect(mockState.value).toBe(0);
            expect(applySpy).toHaveBeenCalledTimes(2);
        });

        it('should handle very large numbers', async () => {
            const client = createClient();
            const largeNumber = Number.MAX_SAFE_INTEGER;

            await client.commit({ name: 'increment', payload: largeNumber });

            await new Promise(resolve => setTimeout(resolve, 100));

            expect(mockState.value).toBe(largeNumber);
        });

        it('should handle rapid sequential operations', async () => {
            const client = createClient();

            for (let i = 1; i <= 20; i++) {
                if (i % 2 === 0) {
                    await client.commit({ name: 'increment', payload: 1 });
                } else {
                    await client.receive({ name: 'increment', payload: 1, sequence: i });
                }
            }

            await new Promise(resolve => setTimeout(resolve, 300));

            expect(mockState.value).toBe(20);
        });

        it('should handle events with clientId in received events', async () => {
            const client = createClient();

            const eventWithClientId: CommittedEvent<'increment', Schema.Schema<number>> = {
                name: 'increment',
                payload: 5,
                sequence: 0,
                clientId: 'other-client-123',
            };

            await client.receive(eventWithClientId);

            expect(mockState.value).toBe(5);
            expect(applySpy).toHaveBeenCalledWith('increment', 5);
        });

        it('should handle out-of-order server confirmations', async () => {
            const client = createClient();

            // Commit multiple events
            await client.commit({ name: 'increment', payload: 1 });
            await client.commit({ name: 'increment', payload: 2 });
            await client.commit({ name: 'increment', payload: 3 });

            await new Promise(resolve => setTimeout(resolve, 100));

            const clientIds = onCommitSpy.mock.calls.map(call => call[0].clientId);

            // Confirm in reverse order
            await client.receive({
                name: 'increment',
                payload: 3,
                sequence: 2,
                clientId: clientIds[2],
            });

            await client.receive({
                name: 'increment',
                payload: 1,
                sequence: 0,
                clientId: clientIds[0],
            });

            await client.receive({
                name: 'increment',
                payload: 2,
                sequence: 1,
                clientId: clientIds[1],
            });

            expect(mockState.value).toBe(6);
            // Should not apply additional times
            expect(applySpy).toHaveBeenCalledTimes(3);
        });
    });

    describe('integration scenarios', () => {
        it('should handle optimistic updates with server confirmation', async () => {
            const client = createClient();

            // Optimistic update
            await client.commit({ name: 'increment', payload: 10 });
            await new Promise(resolve => setTimeout(resolve, 50));

            expect(mockState.value).toBe(10);

            const commitCall = onCommitSpy.mock.calls[0][0];

            // Server confirms
            await client.receive({
                name: 'increment',
                payload: 10,
                sequence: 0,
                clientId: commitCall.clientId,
            });

            // State should remain the same
            expect(mockState.value).toBe(10);
            expect(applySpy).toHaveBeenCalledTimes(1);
        });

        it('should handle optimistic updates with server rejection', async () => {
            const client = createClient();

            // Optimistic update
            await client.commit({ name: 'increment', payload: 10 });
            await new Promise(resolve => setTimeout(resolve, 50));

            expect(mockState.value).toBe(10);

            const commitCall = onCommitSpy.mock.calls[0][0];

            // Server rejects
            await client.receive({
                name: 'increment',
                payload: 10,
                sequence: -1,
                error: true,
                clientId: commitCall.clientId,
            });

            // State should be rolled back
            expect(mockState.value).toBe(0);
            expect(rollbackSpy).toHaveBeenCalledWith('increment', 10);
        });
    });
});
