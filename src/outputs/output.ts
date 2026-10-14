// Where the audio for each cue comes from.
export type Library = {
  names(): string[];
  samples(name: string): Int16Array;
};

// Where cues actually come out: a long-lived audio stream (Linux), a
// long-lived helper process (Windows), or one player process per cue.
export type Output = {
  // Starts any long-lived process, so the first cue isn't slow.
  open(): void;
  // `cut` fades out whatever is playing first (for "alert" cues).
  play(name: string, cut: boolean): void;
  // A cue was redefined; drop anything cached for it.
  forget(name: string): void;
  // Cuts everything that is playing.
  stopAll(): void;
  // The cues that are playing right now.
  playing(): string[];
  // True once this output can't work here, so the player should use another.
  failed(): boolean;
  // Resolves once cues will play without a start-up delay (or the output gave up).
  ready(): Promise<void>;
  close(): void;
};

export type ErrnoListener = (error: NodeJS.ErrnoException) => void;
export type ExitListener = (code: number | null) => void;
