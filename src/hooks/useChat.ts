"use client";

import { useState, useCallback } from "react";
import type { ChatMessage, PullRequest } from "@/lib/types";

type ConversationMap = Map<string, ChatMessage[]>;

export function useChat() {
  const [conversations, setConversations] = useState<ConversationMap>(
    new Map(),
  );
  const [sending, setSending] = useState(false);

  const getKey = (pr: PullRequest) =>
    `${pr.repository.nameWithOwner}:${pr.number}`;

  const getHistory = useCallback(
    (pr: PullRequest): ChatMessage[] => conversations.get(getKey(pr)) ?? [],
    [conversations],
  );

  const sendMessage = useCallback(
    async (pr: PullRequest, message: string) => {
      const key = getKey(pr);
      const currentHistory = conversations.get(key) ?? [];

      // Optimistically add user message
      const withUserMsg: ChatMessage[] = [
        ...currentHistory,
        { role: "user", content: message },
      ];
      setConversations((prev) => new Map(prev).set(key, withUserMsg));
      setSending(true);

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repo: pr.repository.nameWithOwner,
            prNumber: pr.number,
            prTitle: pr.title,
            prBody: pr.body,
            message,
            history: currentHistory,
          }),
        });

        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || "Failed to get response");
        }

        const { reply } = await res.json();
        const withReply: ChatMessage[] = [
          ...withUserMsg,
          { role: "assistant", content: reply },
        ];
        setConversations((prev) => new Map(prev).set(key, withReply));
      } catch (err) {
        // Remove the optimistic user message on error
        setConversations((prev) => new Map(prev).set(key, currentHistory));
        throw err;
      } finally {
        setSending(false);
      }
    },
    [conversations],
  );

  return { getHistory, sendMessage, sending };
}
