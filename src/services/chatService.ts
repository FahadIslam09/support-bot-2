import { db } from '../db/db';
import { customers, conversations, messages } from '../db/schema';
import { eq, and, desc } from 'drizzle-orm';

export class ChatService {
  static async getOrCreateCustomer(pageId: string, psid: string) {
    const existing = await db
      .select()
      .from(customers)
      .where(and(eq(customers.pageId, pageId), eq(customers.psid, psid)))
      .limit(1);

    if (existing.length > 0) {
      const [customer] = await db
        .update(customers)
        .set({ lastActiveAt: new Date() })
        .where(eq(customers.id, existing[0].id))
        .returning();
      return customer;
    }

    const [newCustomer] = await db
      .insert(customers)
      .values({ pageId, psid })
      .returning();
    return newCustomer;
  }

  static async getOrCreateConversation(customerId: string) {
    const existing = await db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.customerId, customerId),
          eq(conversations.status, 'open')
        )
      )
      .limit(1);

    if (existing.length > 0) {
      return existing[0];
    }

    const [newConv] = await db
      .insert(conversations)
      .values({ customerId, status: 'open' })
      .returning();
    return newConv;
  }

  static async logMessage(conversationId: string, role: 'user' | 'assistant' | 'model', content: string) {
    const [newMessage] = await db
      .insert(messages)
      .values({ conversationId, role, content })
      .returning();

    await db
      .update(conversations)
      .set({ lastMessageAt: new Date() })
      .where(eq(conversations.id, conversationId));

    return newMessage;
  }

  static async getRecentChatHistory(conversationId: string, limit = 10) {
    const rawMessages = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.createdAt))
      .limit(limit);

    const chronoMessages = rawMessages.reverse();

    if (chronoMessages.length === 0) return [];

    const sanitized = [];
    let currentMsg = chronoMessages[0];

    for (let i = 1; i < chronoMessages.length; i++) {
      if (chronoMessages[i].role === currentMsg.role) {
        currentMsg = {
          ...currentMsg,
          content: currentMsg.content + '\n' + chronoMessages[i].content,
        };
      } else {
        sanitized.push(currentMsg);
        currentMsg = chronoMessages[i];
      }
    }
    sanitized.push(currentMsg);

    while (sanitized.length > 0 && sanitized[0].role !== 'user') {
      sanitized.shift();
    }

    return sanitized;
  }
}
