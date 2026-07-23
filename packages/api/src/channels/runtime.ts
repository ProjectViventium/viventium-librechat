/**
 * === VIVENTIUM START ===
 * Feature: Channel worker runtime seam.
 * Purpose: Allow provider transports to be injected, restored, tested, stopped, and loopback-QA'd.
 * === VIVENTIUM END ===
 */

import type {
  ChannelConnectionRuntime,
  ChannelId,
  ChannelOutboundMessage,
  ChannelTransport,
  ChannelTransportStartOptions,
  ChannelTransportTestResult,
} from './types';

export class ChannelTransportUnavailableError extends Error {
  constructor(channel: ChannelId) {
    super(`No transport is registered for ${channel}`);
    this.name = 'ChannelTransportUnavailableError';
  }
}

export class ChannelRuntime {
  private readonly transports = new Map<ChannelId, ChannelTransport>();

  register(transport: ChannelTransport): void {
    this.transports.set(transport.channel, transport);
  }

  has(channel: ChannelId): boolean {
    return this.transports.has(channel);
  }

  private requireTransport(channel: ChannelId): ChannelTransport {
    const transport = this.transports.get(channel);
    if (!transport) {
      throw new ChannelTransportUnavailableError(channel);
    }
    return transport;
  }

  async restore(connections: ReadonlyArray<ChannelConnectionRuntime>): Promise<void> {
    for (const connection of connections) {
      const transport = this.transports.get(connection.channel);
      if (transport) {
        await transport.start(connection);
      }
    }
  }

  async start(
    connection: ChannelConnectionRuntime,
    options?: ChannelTransportStartOptions,
  ): Promise<boolean> {
    const result = await this.requireTransport(connection.channel).start(connection, options);
    return result !== false;
  }

  async stop(channel: ChannelId, accountId: string, expectedGeneration?: string): Promise<void> {
    await this.requireTransport(channel).stop(accountId, expectedGeneration);
  }

  async test(connection: ChannelConnectionRuntime): Promise<ChannelTransportTestResult> {
    return await this.requireTransport(connection.channel).test(connection);
  }

  async send(message: ChannelOutboundMessage): Promise<void> {
    await this.requireTransport(message.channel).send(message);
  }
}
