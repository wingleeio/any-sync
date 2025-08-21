import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Schema } from 'effect';
import { Server, ServerOptions } from './server.js';
import { CommitEvent } from './shared.js';

describe('Server', () => {
    let mockState: { value: number };
    let onCommittedSpy: ReturnType<typeof vi.fn>;

    const events = {
        increment: Schema.Number,
        decrement: Schema.Number,
        multiply: Schema.Number,
        reset: Schema.Void,
    };

    const createServer = (overrides: Partial<ServerOptions<typeof events, any>> = {}) => {
        mockState = { value: 0 };
        onCommittedSpy = vi.fn();

        const materializers = {
            increment: (event: CommitEvent<'increment', Schema.Schema<number>>) => {
                mockState.value += event.payload;
                return mockState.value;
            },
            decrement: (event: CommitEvent<'decrement', Schema.Schema<number>>) => {
                if (mockState.value - event.payload < 0) {
                    throw new Error('Cannot go below zero');
                }
                mockState.value -= event.payload;
                return mockState.value;
            },
            multiply: (event: CommitEvent<'multiply', Schema.Schema<number>>) => {
                mockState.value *= event.payload;
                return mockState.value;
            },
            reset: () => {
                mockState.value = 0;
                return mockState.value;
            },
        };

        return new Server({
            sequence: 0,
            events,
            materializers,
            onCommited: onCommittedSpy,
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
        it('should create server instance', () => {
            const server = createServer();
            expect(server).toBeInstanceOf(Server);
        });

        it('should process single event', async () => {
            const server = createServer();

            await server.commit({ name: 'increment', payload: 5 });

            // Give some time for async processing
            await new Promise(resolve => setTimeout(resolve, 100));

            expect(mockState.value).toBe(5);
            expect(onCommittedSpy).toHaveBeenCalledWith({
                name: 'increment',
                payload: 5,
                sequence: 0,
            });
        });

        it('should process multiple events in sequence', async () => {
            const server = createServer();

            await server.commit({ name: 'increment', payload: 5 });
            await server.commit({ name: 'increment', payload: 3 });
            await server.commit({ name: 'decrement', payload: 2 });

            // Give time for processing
            await new Promise(resolve => setTimeout(resolve, 200));

            expect(mockState.value).toBe(6);
            expect(onCommittedSpy).toHaveBeenCalledTimes(3);

            // Check sequence numbers
            expect(onCommittedSpy).toHaveBeenNthCalledWith(1, {
                name: 'increment',
                payload: 5,
                sequence: 0,
            });
            expect(onCommittedSpy).toHaveBeenNthCalledWith(2, {
                name: 'increment',
                payload: 3,
                sequence: 1,
            });
            expect(onCommittedSpy).toHaveBeenNthCalledWith(3, {
                name: 'decrement',
                payload: 2,
                sequence: 2,
            });
        });

        it('should handle void payloads', async () => {
            const server = createServer();

            await server.commit({ name: 'increment', payload: 10 });
            await server.commit({ name: 'reset', payload: undefined });

            await new Promise(resolve => setTimeout(resolve, 200));

            expect(mockState.value).toBe(0);
            expect(onCommittedSpy).toHaveBeenCalledTimes(2);
            expect(onCommittedSpy).toHaveBeenLastCalledWith({
                name: 'reset',
                payload: undefined,
                sequence: 1,
            });
        });

        it('should work with custom sequence start', async () => {
            const server = createServer({ sequence: 100 });

            await server.commit({ name: 'increment', payload: 5 });

            await new Promise(resolve => setTimeout(resolve, 100));

            expect(onCommittedSpy).toHaveBeenCalledWith({
                name: 'increment',
                payload: 5,
                sequence: 100,
            });
        });

        it('should handle events with clientId', async () => {
            const server = createServer();

            await server.commit({ name: 'increment', payload: 5, clientId: 'client-123' });

            await new Promise(resolve => setTimeout(resolve, 100));

            expect(onCommittedSpy).toHaveBeenCalledWith({
                name: 'increment',
                payload: 5,
                clientId: 'client-123',
                sequence: 0,
            });
        });
    });

    describe('error handling', () => {
        it('should handle materializer errors', async () => {
            const server = createServer();

            // This should fail because we can't go below zero
            await server.commit({ name: 'decrement', payload: 5 });

            await new Promise(resolve => setTimeout(resolve, 100));

            expect(mockState.value).toBe(0); // State should not change
            expect(onCommittedSpy).toHaveBeenCalledWith({
                name: 'decrement',
                payload: 5,
                sequence: -1,
                error: true,
            });
        });

        it('should handle async materializer errors', async () => {
            const asyncMaterializers = {
                increment: async (event: CommitEvent<'increment', Schema.Schema<number>>) => {
                    await new Promise(resolve => setTimeout(resolve, 10));
                    throw new Error('Async error');
                },
                decrement: () => {},
                multiply: () => {},
                reset: () => {},
            };

            const server = new Server({
                sequence: 0,
                events,
                materializers: asyncMaterializers,
                onCommited: onCommittedSpy,
            });

            await server.commit({ name: 'increment', payload: 5 });

            await new Promise(resolve => setTimeout(resolve, 100));

            expect(onCommittedSpy).toHaveBeenCalledWith({
                name: 'increment',
                payload: 5,
                sequence: -1,
                error: true,
            });
        });

        it('should continue processing after materializer error', async () => {
            const server = createServer();

            // First event fails
            await server.commit({ name: 'decrement', payload: 5 });
            // Second event should succeed
            await server.commit({ name: 'increment', payload: 3 });

            await new Promise(resolve => setTimeout(resolve, 200));

            expect(mockState.value).toBe(3);
            expect(onCommittedSpy).toHaveBeenCalledTimes(2);

            // First call with error
            expect(onCommittedSpy).toHaveBeenNthCalledWith(1, {
                name: 'decrement',
                payload: 5,
                sequence: -1,
                error: true,
            });

            // Second call successful
            expect(onCommittedSpy).toHaveBeenNthCalledWith(2, {
                name: 'increment',
                payload: 3,
                sequence: 0,
            });
        });

        it('should handle onCommitted callback errors', async () => {
            const failingOnCommitted = vi.fn().mockRejectedValue(new Error('Callback error'));
            const server = createServer({ onCommited: failingOnCommitted });

            await server.commit({ name: 'increment', payload: 5 });

            await new Promise(resolve => setTimeout(resolve, 100));

            // State should still be updated despite callback error
            expect(mockState.value).toBe(5);
            expect(failingOnCommitted).toHaveBeenCalledWith({
                name: 'increment',
                payload: 5,
                sequence: 0,
            });
        });

        it('should handle invalid event schema', async () => {
            const server = createServer();

            // This should fail schema validation
            await expect(
                server.commit({ name: 'increment', payload: 'invalid' } as any)
            ).rejects.toThrow();
        });

        it('should handle unknown event names', async () => {
            const server = createServer();

            await expect(server.commit({ name: 'unknown', payload: 5 } as any)).rejects.toThrow();
        });
    });

    describe('edge cases', () => {
        it('should handle rapid sequential commits', async () => {
            const server = createServer();

            for (let i = 1; i <= 10; i++) {
                await server.commit({ name: 'increment', payload: 1 });
            }

            await new Promise(resolve => setTimeout(resolve, 300));

            expect(mockState.value).toBe(10);
            expect(onCommittedSpy).toHaveBeenCalledTimes(10);
        });

        it('should handle zero and negative values correctly', async () => {
            const server = createServer();

            await server.commit({ name: 'increment', payload: 0 });
            await server.commit({ name: 'multiply', payload: 0 });
            await server.commit({ name: 'increment', payload: 5 });
            await server.commit({ name: 'multiply', payload: -2 });

            await new Promise(resolve => setTimeout(resolve, 200));

            expect(mockState.value).toBe(-10);
        });

        it('should handle very large numbers', async () => {
            const server = createServer();
            const largeNumber = Number.MAX_SAFE_INTEGER;

            await server.commit({ name: 'increment', payload: largeNumber });

            await new Promise(resolve => setTimeout(resolve, 100));

            expect(mockState.value).toBe(largeNumber);
        });
    });
});
