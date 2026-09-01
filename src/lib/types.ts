export interface PullRequest {
  number: number;
  title: string;
  body: string;
  author: {
    login: string;
  };
  repository: {
    nameWithOwner: string;
  };
  createdAt: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  url: string;
}

export type SwipeDirection = "left" | "right";

export interface SwipeRecord {
  repo: string;
  prNumber: number;
  direction: SwipeDirection;
  timestamp: number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}
