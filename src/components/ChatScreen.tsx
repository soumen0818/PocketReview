"use client";

import { useState, useRef, useEffect } from "react";
import { ArrowLeft, Send, Loader2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PullRequest, ChatMessage } from "@/lib/types";

interface ChatScreenProps {
  pr: PullRequest;
  history: ChatMessage[];
  onSend: (message: string) => Promise<void>;
  sending: boolean;
  onClose: () => void;
}

export default function ChatScreen({
  pr,
  history,
  onSend,
  sending,
  onClose,
}: ChatScreenProps) {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history, sending]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const msg = input.trim();
    if (!msg || sending) return;
    setInput("");
    setError(null);
    try {
      await onSend(msg);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 shrink-0">
        <button
          onClick={onClose}
          className="p-1.5 -ml-1 rounded-full hover:bg-gray-100 transition-colors"
          aria-label="Back"
        >
          <ArrowLeft size={20} className="text-gray-700" />
        </button>
        <div className="min-w-0">
          <p className="text-xs text-gray-400 truncate">
            {pr.repository.nameWithOwner} #{pr.number}
          </p>
          <p className="text-sm font-semibold text-gray-900 truncate leading-tight">
            {pr.title}
          </p>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 min-h-0">
        {history.length === 0 && (
          <p className="text-center text-sm text-gray-400 mt-12">
            Ask anything about this PR
          </p>
        )}
        {history.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[80%] px-3.5 py-2.5 rounded-2xl text-sm ${
                msg.role === "user"
                  ? "bg-gray-900 text-white rounded-br-sm whitespace-pre-wrap"
                  : "bg-gray-100 text-gray-800 rounded-bl-sm prose-chat"
              }`}
            >
              {msg.role === "user" ? (
                msg.content
              ) : (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {msg.content}
                </ReactMarkdown>
              )}
            </div>
          </div>
        ))}
        {sending && (
          <div className="flex justify-start">
            <div className="px-3.5 py-2.5 rounded-2xl rounded-bl-sm bg-gray-100">
              <Loader2 size={16} className="animate-spin text-gray-400" />
            </div>
          </div>
        )}
        {error && <p className="text-center text-xs text-red-500">{error}</p>}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <form
        onSubmit={handleSubmit}
        className="flex items-center gap-2 px-4 py-3 border-t border-gray-100 shrink-0"
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about this PR..."
          className="flex-1 px-4 py-2.5 rounded-full bg-gray-100 text-sm outline-none focus:ring-2 focus:ring-gray-300 transition"
          disabled={sending}
          autoFocus
        />
        <button
          type="submit"
          disabled={!input.trim() || sending}
          className="flex items-center justify-center w-9 h-9 rounded-full bg-gray-900 text-white disabled:opacity-40 hover:bg-gray-700 transition-colors shrink-0"
          aria-label="Send"
        >
          <Send size={14} />
        </button>
      </form>
    </div>
  );
}
