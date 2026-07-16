import { pgTable, text, varchar, boolean, timestamp, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const businessConfig = pgTable('business_config', {
  id: text('id').primaryKey(),
  storeName: varchar('store_name', { length: 255 }),
  botName: varchar('bot_name', { length: 255 }).default('AI Assistant'),
  baseCity: varchar('base_city', { length: 255 }).default('Rajshahi'),
  insideCityCharge: varchar('inside_city_charge', { length: 50 }).default('60'),
  outsideCityCharge: varchar('outside_city_charge', { length: 50 }).default('120'),
  aiEnabled: boolean('ai_enabled').default(true),
  systemPersona: text('system_persona'),
  deliveryPolicy: text('delivery_policy'),
  paymentPolicy: text('payment_policy'),
});

export const products = pgTable('products', {
  id: text('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  price: varchar('price', { length: 50 }),
  sizes: text('sizes'),
  features: text('features'),
  isActive: boolean('is_active').default(true),
});

export const customers = pgTable('customers', {
  id: text('id').primaryKey().default(sql`gen_random_uuid()`),
  pageId: varchar('page_id', { length: 255 }).notNull(),
  psid: varchar('psid', { length: 255 }).notNull(),
  firstName: varchar('first_name', { length: 255 }),
  lastName: varchar('last_name', { length: 255 }),
  lastActiveAt: timestamp('last_active_at').defaultNow(),
}, (t) => ({
  unq: unique().on(t.pageId, t.psid),
}));

export const conversations = pgTable('conversations', {
  id: text('id').primaryKey().default(sql`gen_random_uuid()`),
  customerId: text('customer_id').references(() => customers.id, { onDelete: 'cascade' }),
  summary: text('summary'),
  status: varchar('status', { length: 50 }).default('open'),
  startedAt: timestamp('started_at').defaultNow(),
  lastMessageAt: timestamp('last_message_at').defaultNow(),
});

export const messages = pgTable('messages', {
  id: text('id').primaryKey().default(sql`gen_random_uuid()`),
  conversationId: text('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }),
  role: varchar('role', { length: 50 }).notNull(),
  content: text('content').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});
