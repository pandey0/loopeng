export interface CoordinationStrategy {
  dispatch(cardId: string): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}
