import { EntityManager, EntitySchema } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { OutboxRecord } from './outbox-message';

export class OutboxMessageEntity {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  publishedAt?: Date;
}

export const outboxMessageSchema = new EntitySchema<OutboxMessageEntity>({
  class: OutboxMessageEntity,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'string', length: 128 },
    eventType: { type: 'string', length: 128 },
    payload: { type: 'json', columnType: 'jsonb' },
    occurredAt: { type: 'Date', columnType: 'timestamptz' },
    publishedAt: { type: 'Date', columnType: 'timestamptz', nullable: true },
  },
});

@Injectable()
export class OutboxRepository {
  async addAll(em: EntityManager, records: OutboxRecord[]): Promise<void> {
    if (records.length === 0) {
      return;
    }

    for (const record of records) {
      const entity = new OutboxMessageEntity();
      entity.id = record.id;
      entity.aggregateId = record.aggregateId;
      entity.eventType = record.eventType;
      entity.payload = record.payload as unknown as Record<string, unknown>;
      entity.occurredAt = record.occurredAt;
      em.persist(entity);
    }

    await em.flush();
  }

  async countPending(em: EntityManager): Promise<number> {
    return em.count(OutboxMessageEntity, { publishedAt: null });
  }
}
