"use client";

import { useState, useEffect, useCallback } from "react";
import { Volume2, Square } from "lucide-react";

interface VoiceButtonProps {
  /** What to read aloud. */
  text: string;
}

/**
 * Hands-free playback via the Web Speech API.
 *
 * Zero backend cost and no extra dependency — `speechSynthesis` ships in the
 * browser. Positioned as a genuine context feature for triage on a commute,
 * explicitly not the headline innovation.
 *
 * Renders nothing when the browser has no speech synthesis, rather than
 * showing a button that does nothing.
 */
export default function VoiceButton({ text }: VoiceButtonProps) {
  const [supported, setSupported] = useState(false);
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => {
    setSupported(typeof window !== "undefined" && "speechSynthesis" in window);
  }, []);

  // Speech continues after unmount unless it is explicitly cancelled — leaving
  // a voice reading a card the user has already swiped away.
  useEffect(() => {
    return () => {
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const toggle = useCallback(() => {
    if (!supported) return;

    if (speaking) {
      window.speechSynthesis.cancel();
      setSpeaking(false);
      return;
    }

    // Cancel anything already queued, so tapping a second card does not read
    // both explanations over each other.
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.05;
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);

    window.speechSynthesis.speak(utterance);
    setSpeaking(true);
  }, [supported, speaking, text]);

  if (!supported) return null;

  return (
    <button
      onClick={toggle}
      className="flex items-center gap-1.5 rounded-full border border-gray-200 px-3 py-1.5 text-[11px] font-medium text-gray-600 transition-colors hover:bg-gray-50 active:bg-gray-100"
      aria-label={
        speaking ? "Stop reading aloud" : "Read this explanation aloud"
      }
    >
      {speaking ? <Square size={11} /> : <Volume2 size={12} />}
      {speaking ? "Stop" : "Listen"}
    </button>
  );
}
