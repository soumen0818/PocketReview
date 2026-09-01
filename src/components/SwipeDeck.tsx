"use client";

import { useRef, useState } from "react";
import TinderCard from "react-tinder-card";
import PRCard from "./PRCard";
import type { PullRequest } from "@/lib/types";

interface SwipeDeckProps {
  prs: PullRequest[];
  onSwipeLeft: (pr: PullRequest) => void;
  onSwipeRight: (pr: PullRequest) => void;
  triggerSwipe?: { direction: "left" | "right" } | null;
  onTriggerConsumed?: () => void;
}

export default function SwipeDeck({
  prs,
  onSwipeLeft,
  onSwipeRight,
  triggerSwipe,
  onTriggerConsumed,
}: SwipeDeckProps) {
  const visible = prs.slice(0, 3);
  const cardRef = useRef<{ swipe: (dir: string) => Promise<void> } | null>(
    null,
  );
  const [triggered, setTriggered] = useState(false);

  if (triggerSwipe && !triggered && cardRef.current) {
    setTriggered(true);
    cardRef.current.swipe(triggerSwipe.direction).then(() => {
      setTriggered(false);
      onTriggerConsumed?.();
    });
  }

  function handleSwipe(direction: string, pr: PullRequest) {
    if (direction === "right") onSwipeRight(pr);
    else if (direction === "left") onSwipeLeft(pr);
  }

  return (
    // flex-1 + relative: fills the available space in the flex column,
    // and provides a positioning context for absolute children.
    <div className="flex-1 relative w-full min-h-0">
      {/* absolute inset-0 fills the flex-1 parent reliably */}
      <div className="absolute inset-0 pt-2 pb-1">
        {visible
          .slice()
          .reverse()
          .map((pr, reverseIndex) => {
            const index = visible.length - 1 - reverseIndex;
            const isTop = index === 0;
            const scale = 1 - index * 0.035;
            const translateY = index * 12;

            return (
              <div
                key={`${pr.repository.nameWithOwner}:${pr.number}`}
                className="absolute inset-0"
                style={{
                  transform: `scale(${scale}) translateY(${translateY}px)`,
                  transformOrigin: "top center",
                  zIndex: visible.length - index,
                }}
              >
                {isTop ? (
                  <TinderCard
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    ref={cardRef as any}
                    className="h-full"
                    onSwipe={(dir) => handleSwipe(dir, pr)}
                    preventSwipe={["up", "down"]}
                    swipeRequirementType="position"
                    swipeThreshold={80}
                  >
                    <SwipeOverlayCard pr={pr} />
                  </TinderCard>
                ) : (
                  <PRCard pr={pr} />
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}

function SwipeOverlayCard({ pr }: { pr: PullRequest }) {
  const startX = useRef<number | null>(null);
  const [dragDelta, setDragDelta] = useState(0);

  return (
    <div
      className="relative h-full"
      onPointerDown={(e) => {
        // Don't track drag when clicking interactive elements
        if ((e.target as HTMLElement).closest("button, a, input")) return;
        startX.current = e.clientX;
        setDragDelta(0);
      }}
      onPointerMove={(e) => {
        if (e.buttons === 1 && startX.current !== null) {
          setDragDelta(e.clientX - startX.current);
        }
      }}
      onPointerUp={() => {
        startX.current = null;
        setDragDelta(0);
      }}
      onPointerLeave={() => {
        startX.current = null;
        setDragDelta(0);
      }}
    >
      <PRCard pr={pr} />
      {dragDelta > 30 && (
        <div className="absolute inset-0 rounded-2xl border-4 border-green-400 flex items-center justify-center bg-green-50/50 pointer-events-none">
          <span className="text-green-500 font-black text-3xl -rotate-12 tracking-widest text-center leading-tight">
            FAST
            <br />
            TRACK
          </span>
        </div>
      )}
      {dragDelta < -30 && (
        <div className="absolute inset-0 rounded-2xl border-4 border-amber-400 flex items-center justify-center bg-amber-50/50 pointer-events-none">
          <span className="text-amber-500 font-black text-3xl rotate-12 tracking-widest text-center leading-tight">
            NEEDS
            <br />
            REVIEW
          </span>
        </div>
      )}
    </div>
  );
}
