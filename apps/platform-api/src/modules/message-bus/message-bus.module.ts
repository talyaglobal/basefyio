import { Global, Module } from '@nestjs/common';
import { MESSAGE_BUS } from './message-bus.port';
import { AmqpMessageBus } from './amqp-message-bus.service';

/**
 * The message bus, available everywhere through the MESSAGE_BUS token. One
 * implementation (AMQP on RabbitMQ) that is inert without MESSAGE_BUS_URL, so
 * every producer can be written now and starts working the day the broker
 * exists.
 */
@Global()
@Module({
  providers: [AmqpMessageBus, { provide: MESSAGE_BUS, useExisting: AmqpMessageBus }],
  exports: [MESSAGE_BUS, AmqpMessageBus],
})
export class MessageBusModule {}
