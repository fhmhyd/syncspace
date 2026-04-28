"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const BASE_WORDS = [
  "about", "after", "again", "air", "all", "along", "also", "always", "another", "answer",
  "around", "ask", "back", "because", "before", "below", "between", "both", "bring", "build",
  "change", "child", "city", "close", "come", "consider", "course", "day", "different", "down",
  "early", "earth", "end", "enough", "even", "every", "example", "family", "feel", "find",
  "first", "follow", "form", "friend", "general", "give", "good", "great", "group", "hand",
  "have", "help", "here", "high", "home", "house", "important", "keep", "kind", "know",
  "large", "last", "learn", "leave", "life", "little", "long", "make", "mean", "might",
  "month", "more", "most", "move", "much", "name", "need", "never", "night", "number",
  "often", "open", "other", "part", "people", "person", "place", "plan", "point", "problem",
  "public", "question", "quick", "real", "right", "school", "seem", "should", "small", "sound",
  "stand", "start", "state", "still", "such", "system", "take", "tell", "than", "their",
  "them", "there", "these", "thing", "think", "those", "through", "time", "today", "together",
  "turn", "under", "until", "use", "very", "want", "water", "where", "while", "with",
  "word", "work", "world", "would", "write", "year", "young"
];

const PUNCTUATION = [".", ",", ";", ":", "!", "?"];
const NUMBER_WORDS = ["2026", "15", "30", "60", "120", "404", "99", "7"];
const TIME_OPTIONS = [15, 30, 60, 120] as const;
const WORD_OPTIONS = [10, 25, 50, 100] as const;

type Mode = "time" | "words";

type Status = "idle" | "running" | "finished";

function KeyboardIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="brand-icon">
      <rect x="2.5" y="5" width="19" height="14" rx="3" />
      <path d="M6 9h1.6M9 9h1.6M12 9h1.6M15 9h1.6M6 12h1.6M9 12h1.6M12 12h1.6M15 12h1.6M7 15h10" />
    </svg>
  );
}

function buildWordSet(count: number, includePunctuation: boolean, includeNumbers: boolean) {
  const words: string[] = [];

  for (let index = 0; index < count; index += 1) {
    let word = BASE_WORDS[Math.floor(Math.random() * BASE_WORDS.length)];

    if (includeNumbers && index % 9 === 4) {
      word = NUMBER_WORDS[Math.floor(Math.random() * NUMBER_WORDS.length)];
    }

    if (includePunctuation && index % 7 === 3) {
      word = `${word}${PUNCTUATION[Math.floor(Math.random() * PUNCTUATION.length)]}`;
    }

    words.push(word);
  }

  return words;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export default function TypingTest() {
  const [mode, setMode] = useState<Mode>("time");
  const [duration, setDuration] = useState<(typeof TIME_OPTIONS)[number]>(60);
  const [wordGoal, setWordGoal] = useState<(typeof WORD_OPTIONS)[number]>(50);
  const [includePunctuation, setIncludePunctuation] = useState(false);
  const [includeNumbers, setIncludeNumbers] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [typedValue, setTypedValue] = useState("");
  const [timeLeft, setTimeLeft] = useState<number>(duration);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [viewportWidth, setViewportWidth] = useState(1440);

  const startTimeRef = useRef<number | null>(null);
  const finishTimeRef = useRef<number | null>(null);
  const expectedWordsRef = useRef<string[]>([]);
  const testRootRef = useRef<HTMLDivElement | null>(null);

  const regenerate = useCallback(() => {
    const nextWords = buildWordSet(mode === "time" ? 140 : wordGoal, includePunctuation, includeNumbers);
    expectedWordsRef.current = nextWords;
    setTypedValue("");
    setStatus("idle");
    setTimeLeft(duration);
    startTimeRef.current = null;
    finishTimeRef.current = null;
  }, [duration, includeNumbers, includePunctuation, mode, wordGoal]);

  useEffect(() => {
    regenerate();
  }, [regenerate]);

  const expectedWords = expectedWordsRef.current;
  const expectedText = useMemo(() => expectedWords.join(" "), [expectedWords]);

  useEffect(() => {
    if (mode === "time") {
      setTimeLeft(duration);
    }
  }, [duration, mode]);

  useEffect(() => {
    if (status !== "running" || mode !== "time" || !startTimeRef.current) {
      return;
    }

    const intervalId = window.setInterval(() => {
      if (!startTimeRef.current) {
        return;
      }

      const elapsedSeconds = (Date.now() - startTimeRef.current) / 1000;
      const remaining = clamp(Math.ceil(duration - elapsedSeconds), 0, duration);
      setTimeLeft(remaining);

      if (remaining === 0) {
        finishTimeRef.current = Date.now();
        setStatus("finished");
      }
    }, 100);

    return () => window.clearInterval(intervalId);
  }, [duration, mode, status]);

  const finishTest = useCallback(() => {
    finishTimeRef.current = Date.now();
    setStatus("finished");
  }, []);

  useEffect(() => {
    if (mode === "words" && typedValue.length >= expectedText.length && status === "running") {
      finishTest();
    }
  }, [expectedText.length, finishTest, mode, status, typedValue.length]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Tab") {
        event.preventDefault();
        regenerate();
        return;
      }

      if (event.key === "Escape") {
        regenerate();
        return;
      }

      if (event.metaKey || event.ctrlKey || event.altKey || status === "finished") {
        return;
      }

      if (event.key === "Backspace") {
        event.preventDefault();
        setTypedValue((current) => current.slice(0, -1));
        return;
      }

      if (event.key.length !== 1) {
        return;
      }

      event.preventDefault();

      setTypedValue((current) => {
        if (status === "idle") {
          startTimeRef.current = Date.now();
          setStatus("running");
        }

        if (mode === "time" && timeLeft === 0) {
          return current;
        }

        return current + event.key;
      });
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mode, regenerate, status, timeLeft]);

  useEffect(() => {
    testRootRef.current?.focus();
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const syncViewport = () => setViewportWidth(window.innerWidth);

    syncViewport();
    window.addEventListener("resize", syncViewport);

    return () => window.removeEventListener("resize", syncViewport);
  }, []);

  const totalTypedChars = typedValue.length;
  const correctChars = typedValue.split("").reduce((count, character, index) => {
    return count + (character === expectedText[index] ? 1 : 0);
  }, 0);
  const incorrectChars = totalTypedChars - correctChars;
  const elapsedMs =
    status === "finished"
      ? (finishTimeRef.current ?? Date.now()) - (startTimeRef.current ?? Date.now())
      : status === "running"
        ? Date.now() - (startTimeRef.current ?? Date.now())
        : 0;
  const elapsedMinutes = Math.max(elapsedMs / 60000, 1 / 60000);
  const wpm = Math.round(correctChars / 5 / elapsedMinutes);
  const accuracy = totalTypedChars === 0 ? 100 : Math.round((correctChars / totalTypedChars) * 100);
  const typedWordCount = typedValue.trim().length === 0 ? 0 : typedValue.trim().split(/\s+/).length;
  const completedWordCount = typedValue.split("").reduce((count, character) => count + (character === " " ? 1 : 0), 0);
  const characterBudget = viewportWidth < 640 ? 70 : viewportWidth < 960 ? 120 : 180;
  const windowStartWordIndex = Math.max(0, completedWordCount - (viewportWidth < 640 ? 2 : 4));
  const renderWindow = useMemo(() => {
    let consumedCharacters = 0;
    let fromGlobalChar = 0;

    for (let index = 0; index < windowStartWordIndex; index += 1) {
      fromGlobalChar += expectedWords[index].length + 1;
    }

    const words: string[] = [];

    for (let index = windowStartWordIndex; index < expectedWords.length; index += 1) {
      const nextWord = expectedWords[index];
      const nextLength = nextWord.length + (words.length > 0 ? 1 : 0);

      if (words.length > 0 && consumedCharacters + nextLength > characterBudget) {
        break;
      }

      words.push(nextWord);
      consumedCharacters += nextLength;
    }

    return { fromGlobalChar, words };
  }, [characterBudget, expectedWords, windowStartWordIndex]);

  const renderedWords = renderWindow.words;
  let globalIndex = renderWindow.fromGlobalChar;

  return (
    <main className="typing-shell">
      <div className="typing-noise" />
      <header className="typing-header">
        <div className="brand-block">
          <KeyboardIcon />
          <div className="brand-copy">
            <span className="brand-kicker">typing practice</span>
            <h1>synctype</h1>
          </div>
        </div>
        <div className="header-meta">
          <button
            type="button"
            className="theme-toggle"
            onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
          >
            {theme === "dark" ? "light mode" : "dark mode"}
          </button>
        </div>
      </header>

      <section className="control-row">
        <div className="control-group">
          <button
            className={`control-chip ${includePunctuation ? "is-active" : ""}`}
            type="button"
            onClick={() => setIncludePunctuation((current) => !current)}
          >
            punctuation
          </button>
          <button
            className={`control-chip ${includeNumbers ? "is-active" : ""}`}
            type="button"
            onClick={() => setIncludeNumbers((current) => !current)}
          >
            numbers
          </button>
        </div>

        <div className="control-group">
          <button
            className={`control-chip ${mode === "time" ? "is-active" : ""}`}
            type="button"
            onClick={() => setMode("time")}
          >
            time
          </button>
          <button
            className={`control-chip ${mode === "words" ? "is-active" : ""}`}
            type="button"
            onClick={() => setMode("words")}
          >
            words
          </button>
        </div>

        <div className="control-group">
          {(mode === "time" ? TIME_OPTIONS : WORD_OPTIONS).map((option) => {
            const isActive = mode === "time" ? duration === option : wordGoal === option;

            return (
              <button
                key={option}
                className={`control-chip ${isActive ? "is-active" : ""}`}
                type="button"
                onClick={() => {
                  if (mode === "time") {
                    setDuration(option as (typeof TIME_OPTIONS)[number]);
                  } else {
                    setWordGoal(option as (typeof WORD_OPTIONS)[number]);
                  }
                }}
              >
                {option}
              </button>
            );
          })}
        </div>
      </section>

      <section className="typing-stage" ref={testRootRef} tabIndex={-1}>
        <div className="stage-meta">
          <span>english</span>
          <span>{mode === "time" ? `${timeLeft}s left` : `${wordGoal} word target`}</span>
        </div>

        <div className="word-frame">
          <div className="word-stream" aria-label="typing words">
          {renderedWords.map((word, wordIndex) => {
            const chars = word.split("");
            const wordMarkup = chars.map((character, charIndex) => {
              const currentIndex = globalIndex;
              const typedCharacter = typedValue[currentIndex];
              const isTyped = currentIndex < typedValue.length;
              const isCorrect = typedCharacter === character;
              const isCurrent = currentIndex === typedValue.length && status !== "finished";

              globalIndex += 1;

              return (
                <span
                  key={`${wordIndex}-${charIndex}-${character}`}
                  className={[
                    "char",
                    isTyped ? (isCorrect ? "is-correct" : "is-incorrect") : "",
                    isCurrent ? "is-current" : ""
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  {character}
                </span>
              );
            });

            const spacerIndex = globalIndex;
            const typedSpace = typedValue[spacerIndex];
            const isSpaceTyped = spacerIndex < typedValue.length;
            const isSpaceCurrent = spacerIndex === typedValue.length && status !== "finished";

            globalIndex += 1;

            return (
              <span key={`${word}-${wordIndex}`} className="word">
                {wordMarkup}
                {wordIndex < renderedWords.length - 1 ? (
                  <span
                    className={[
                      "char",
                      "char-space",
                      isSpaceTyped ? (typedSpace === " " ? "is-correct" : "is-incorrect") : "",
                      isSpaceCurrent ? "is-current" : ""
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    {" "}
                  </span>
                ) : null}
              </span>
            );
          })}
          </div>
        </div>
      </section>

      <section className="result-strip" aria-hidden={status === "finished"}>
        <div className="result-block">
          <span className="result-label">wpm</span>
          <strong>{status === "idle" ? "--" : wpm}</strong>
        </div>
        <div className="result-block">
          <span className="result-label">accuracy</span>
          <strong>{status === "idle" ? "--" : `${accuracy}%`}</strong>
        </div>
        <div className="result-block">
          <span className="result-label">errors</span>
          <strong>{incorrectChars}</strong>
        </div>
      </section>

      <footer className="typing-footer">
        <span className="restart-pill">tab</span>
        <span>restart test</span>
      </footer>

      {status === "finished" ? (
        <div className="results-overlay" role="dialog" aria-modal="true" aria-label="Typing results">
          <div className="results-panel">
            <span className="results-kicker">test complete</span>
            <h2>{wpm} wpm</h2>
            <p className="results-summary">
              {accuracy}% accuracy with {incorrectChars} mistakes in {Math.max(1, Math.round(elapsedMs / 1000))} seconds.
            </p>
            <div className="results-grid">
              <div className="results-stat">
                <span>accuracy</span>
                <strong>{accuracy}%</strong>
              </div>
              <div className="results-stat">
                <span>errors</span>
                <strong>{incorrectChars}</strong>
              </div>
              <div className="results-stat">
                <span>time</span>
                <strong>{Math.max(1, Math.round(elapsedMs / 1000))}s</strong>
              </div>
              <div className="results-stat">
                <span>words</span>
                <strong>{typedWordCount}</strong>
              </div>
            </div>
            <button type="button" className="continue-test" onClick={regenerate}>
              Try again
            </button>
          </div>
        </div>
      ) : null}
    </main>
  );
}
