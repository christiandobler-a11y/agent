import type { DbClient } from "./client.js";

/** Telegram-Verlauf = Gedächtnis des Managers (ARCHITECTURE.md 9). */

export interface StoredMessage {
  direction: "IN" | "OUT";
  text: string | null;
  created_at: Date;
}

export async function insertMessage(
  db: DbClient,
  m: { chatId: number; direction: "IN" | "OUT"; text: string; toolCalls?: unknown },
): Promise<void> {
  await db.query("insert into messages (chat_id, direction, text, tool_calls) values ($1, $2, $3, $4)", [
    m.chatId,
    m.direction,
    m.text,
    m.toolCalls ? JSON.stringify(m.toolCalls) : null,
  ]);
}

/** Letzte Nachrichten eines Chats, älteste zuerst. */
export async function recentMessages(db: DbClient, chatId: number, limit: number): Promise<StoredMessage[]> {
  const { rows } = await db.query<StoredMessage>(
    `select direction, text, created_at from (
       select direction, text, created_at from messages where chat_id = $1 order by created_at desc limit $2
     ) m order by created_at`,
    [chatId, limit],
  );
  return rows;
}
