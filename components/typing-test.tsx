"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from "react";

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
const TARGET_VISIBLE_LINES = 3;
const APPEND_BATCH = 18;

type Mode = "time" | "words";
type Status = "idle" | "running" | "finished";

type WordState = {
  id: number;
  text: string;
  typed: string;
  extras: string[];
  submitted: boolean;
  incorrect: boolean;
};

type CaretPosition = {
  left: number;
  top: number;
  height: number;
  visible: boolean;
};

function KeyboardIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="brand-icon">
      <rect x="2.5" y="5" width="19" height="14" rx="3" />
      <path d="M6 9h1.6M9 9h1.6M12 9h1.6M15 9h1.6M6 12h1.6M9 12h1.6M12 12h1.6M15 12h1.6M7 15h10" />
    </svg>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function createWords(
  count: number,
  includePunctuation: boolean,
  includeNumbers: boolean,
  nextIdRef: MutableRefObject<number>
) {
  return Array.from({ length: count }, (_, index) => {
    let text = BASE_WORDS[Math.floor(Math.random() * BASE_WORDS.length)];

    if (includeNumbers && index % 9 === 4) {
      text = NUMBER_WORDS[Math.floor(Math.random() * NUMBER_WORDS.length)];
    }

    if (includePunctuation && index % 7 === 3) {
      text = `${text}${PUNCTUATION[Math.floor(Math.random() * PUNCTUATION.length)]}`;
    }

    return {
      id: nextIdRef.current++,
      text,
      typed: "",
      extras: [],
      submitted: false,
      incorrect: false
    } satisfies WordState;
  });
}

function getWordIncorrect(word: WordState) {
  if (word.extras.length > 0) {
    return true;
  }

  if (word.typed.length !== word.text.length) {
    return true;
  }

  return word.typed.split("").some((character, index) => character !== word.text[index]);
}

export default function TypingTest() {
  const [mode, setMode] = useState<Mode>("time");
  const [duration, setDuration] = useState<(typeof TIME_OPTIONS)[number]>(60);
  const [wordGoal, setWordGoal] = useState<(typeof WORD_OPTIONS)[number]>(50);
  const [includePunctuation, setIncludePunctuation] = useState(false);
  const [includeNumbers, setIncludeNumbers] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [timeLeft, setTimeLeft] = useState<number>(duration);
  const [words, setWords] = useState<WordState[]>([]);
  const [currentWordIndex, setCurrentWordIndex] = useState(0);
  const [caret, setCaret] = useState<CaretPosition>({ left: 0, top: 0, height: 0, visible: false });
  const [typedCharCount, setTypedCharCount] = useState(0);
  const [totalKeystrokes, setTotalKeystrokes] = useState(0);
  const [correctKeystrokes, setCorrectKeystrokes] = useState(0);

  const nextIdRef = useRef(1);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const wordFrameRef = useRef<HTMLDivElement | null>(null);
  const wordRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const caretAnchorRef = useRef<HTMLSpanElement | null>(null);
  const prevLineIndexRef = useRef(0);
  const lineHeightRef = useRef(0);
  const startTimeRef = useRef<number | null>(null);
  const finishTimeRef = useRef<number | null>(null);

  const regenerate = useCallback(() => {
    setWords(createWords(32, includePunctuation, includeNumbers, nextIdRef));
    setCurrentWordIndex(0);
    setStatus("idle");
    setTimeLeft(duration);
    setTypedCharCount(0);
    setTotalKeystrokes(0);
    setCorrectKeystrokes(0);
    prevLineIndexRef.current = 0;
    lineHeightRef.current = 0;
    startTimeRef.current = null;
    finishTimeRef.current = null;
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [duration, includeNumbers, includePunctuation]);

  useEffect(() => {
    regenerate();
  }, [regenerate]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

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

  const appendWords = useCallback((count: number) => {
    setWords((current) => [...current, ...createWords(count, includePunctuation, includeNumbers, nextIdRef)]);
  }, [includeNumbers, includePunctuation]);

  const finalizeWord = useCallback((index: number, moveNext: boolean) => {
    let wordIncorrect = false;

    setWords((current) => {
      const nextWords = [...current];
      const word = nextWords[index];

      if (!word) {
        return current;
      }

      wordIncorrect = getWordIncorrect(word);
      nextWords[index] = {
        ...word,
        submitted: true,
        incorrect: wordIncorrect
      };

      return nextWords;
    });

    if (moveNext) {
      setCurrentWordIndex((current) => current + 1);
    }

    return wordIncorrect;
  }, []);

  const handleCharacter = useCallback((character: string) => {
    if (status === "finished") {
      return;
    }

    if (status === "idle") {
      startTimeRef.current = Date.now();
      setStatus("running");
    }

    if (mode === "time" && timeLeft === 0) {
      return;
    }

    const targetWord = words[currentWordIndex];
    if (!targetWord) {
      return;
    }

    const baseIndex = targetWord.typed.length;
    const expectedCharacter = baseIndex < targetWord.text.length ? targetWord.text[baseIndex] : null;
    const isCorrect = expectedCharacter === character;

    setWords((current) => {
      const nextWords = [...current];
      const word = nextWords[currentWordIndex];

      if (!word) {
        return current;
      }

      if (word.typed.length < word.text.length) {
        nextWords[currentWordIndex] = {
          ...word,
          typed: word.typed + character
        };
      } else {
        nextWords[currentWordIndex] = {
          ...word,
          extras: [...word.extras, character]
        };
      }

      return nextWords;
    });

    setTypedCharCount((current) => current + 1);
    setTotalKeystrokes((current) => current + 1);
    setCorrectKeystrokes((current) => current + (isCorrect ? 1 : 0));
  }, [currentWordIndex, mode, status, timeLeft, words]);

  const handleBackspace = useCallback(() => {
    if (status === "finished") {
      return;
    }

    const currentWord = words[currentWordIndex];
    if (!currentWord) {
      return;
    }

    if (currentWord.extras.length > 0) {
      setWords((current) => {
        const nextWords = [...current];
        const word = nextWords[currentWordIndex];
        if (!word) {
          return current;
        }

        nextWords[currentWordIndex] = {
          ...word,
          extras: word.extras.slice(0, -1)
        };
        return nextWords;
      });
      return;
    }

    if (currentWord.typed.length > 0) {
      setWords((current) => {
        const nextWords = [...current];
        const word = nextWords[currentWordIndex];
        if (!word) {
          return current;
        }

        nextWords[currentWordIndex] = {
          ...word,
          typed: word.typed.slice(0, -1),
          submitted: false,
          incorrect: false
        };

        return nextWords;
      });
      return;
    }

    if (currentWordIndex === 0) {
      return;
    }

    const previousWord = words[currentWordIndex - 1];
    if (!previousWord || !previousWord.incorrect) {
      return;
    }

    setCurrentWordIndex((current) => current - 1);
    setWords((current) => {
      const nextWords = [...current];
      const word = nextWords[currentWordIndex - 1];
      if (!word) {
        return current;
      }

      nextWords[currentWordIndex - 1] = {
        ...word,
        submitted: false
      };

      return nextWords;
    });
  }, [currentWordIndex, status, words]);

  const handleSpace = useCallback(() => {
    if (status === "finished") {
      return;
    }

    if (status === "idle") {
      startTimeRef.current = Date.now();
      setStatus("running");
    }

    const currentWord = words[currentWordIndex];
    if (!currentWord) {
      return;
    }

    const expectedSpaceCorrect = currentWord.typed.length === currentWord.text.length && currentWord.extras.length === 0;
    setTotalKeystrokes((current) => current + 1);
    setCorrectKeystrokes((current) => current + (expectedSpaceCorrect ? 1 : 0));

    finalizeWord(currentWordIndex, true);
  }, [currentWordIndex, finalizeWord, status, words]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Tab") {
      event.preventDefault();
      regenerate();
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      regenerate();
      return;
    }

    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }

    if (event.key === "Backspace") {
      event.preventDefault();
      handleBackspace();
      return;
    }

    if (event.key === " ") {
      event.preventDefault();
      handleSpace();
      return;
    }

    if (event.key.length === 1) {
      event.preventDefault();
      handleCharacter(event.key);
    }
  }, [handleBackspace, handleCharacter, handleSpace, regenerate]);

  useEffect(() => {
    if (mode === "words" && currentWordIndex >= wordGoal && status === "running") {
      finishTimeRef.current = Date.now();
      setStatus("finished");
    }
  }, [currentWordIndex, mode, status, wordGoal]);

  useLayoutEffect(() => {
    if (!wordFrameRef.current || words.length === 0) {
      return;
    }

    const refs = words
      .map((word) => ({ id: word.id, element: wordRefs.current.get(word.id) }))
      .filter((entry): entry is { id: number; element: HTMLDivElement } => Boolean(entry.element));

    if (refs.length === 0) {
      return;
    }

    const lineMap = new Map<number, number>();
    let lineIndex = -1;
    let lastTop = Number.NaN;

    refs.forEach(({ id, element }) => {
      const top = element.offsetTop;
      if (Number.isNaN(lastTop) || top !== lastTop) {
        lineIndex += 1;
        lastTop = top;
      }
      lineMap.set(id, lineIndex);
    });

    const visibleLineCount = lineIndex + 1;

    if (visibleLineCount < TARGET_VISIBLE_LINES + 1) {
      appendWords(APPEND_BATCH);
      return;
    }

    if (currentWordIndex >= words.length - 12) {
      appendWords(APPEND_BATCH);
    }

    const activeWord = words[currentWordIndex];
    if (!activeWord) {
      return;
    }

    const activeLine = lineMap.get(activeWord.id) ?? 0;
    const activeElement = wordRefs.current.get(activeWord.id);

    if (activeElement) {
      lineHeightRef.current = activeElement.getBoundingClientRect().height;
    }

    if (activeLine > prevLineIndexRef.current && activeLine >= 2 && lineHeightRef.current > 0) {
      const removableCount = refs.filter(({ id }) => (lineMap.get(id) ?? 0) === 0).length;

      if (removableCount > 0) {
        setWords((current) => {
          const trimmed = current.slice(removableCount);
          return [...trimmed, ...createWords(Math.max(removableCount, 10), includePunctuation, includeNumbers, nextIdRef)];
        });
        setCurrentWordIndex((current) => current - removableCount);
        prevLineIndexRef.current = Math.max(0, activeLine - 1);
      }

      return;
    }

    prevLineIndexRef.current = activeLine;
  }, [appendWords, currentWordIndex, includeNumbers, includePunctuation, words]);

  useLayoutEffect(() => {
    if (!wordFrameRef.current || !caretAnchorRef.current || status === "finished") {
      setCaret((current) => ({ ...current, visible: false }));
      return;
    }

    const frameRect = wordFrameRef.current.getBoundingClientRect();
    const anchorRect = caretAnchorRef.current.getBoundingClientRect();

      setCaret({
        left: anchorRect.left - frameRect.left,
        top: anchorRect.top - frameRect.top,
        height: anchorRect.height,
        visible: true
      });
  }, [currentWordIndex, status, words]);

  const elapsedMs =
    status === "finished"
      ? (finishTimeRef.current ?? Date.now()) - (startTimeRef.current ?? Date.now())
      : status === "running"
        ? Date.now() - (startTimeRef.current ?? Date.now())
        : 0;
  const elapsedMinutes = Math.max(elapsedMs / 60000, 1 / 60000);
  const wpm = Math.round((typedCharCount / 5) / elapsedMinutes);
  const accuracy = totalKeystrokes === 0 ? 100 : Math.round((correctKeystrokes / totalKeystrokes) * 100);
  const currentMetric = mode === "time" ? timeLeft : Math.max(0, wordGoal - currentWordIndex);

  const visibleWords = useMemo(() => {
    if (mode === "words") {
      return words.slice(0, wordGoal + 30);
    }
    return words;
  }, [mode, wordGoal, words]);

  return (
    <main className="typing-shell" onClick={() => inputRef.current?.focus()}>
      <header className="typing-header">
        <div className="brand-block">
          <KeyboardIcon />
          <div className="brand-copy">
            <span className="brand-kicker">precision typing</span>
            <h1>synctype</h1>
          </div>
        </div>
      </header>

      <section className="control-row">
        <div className="control-cluster">
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

        <div className="control-cluster">
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

        <div className="control-cluster">
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

      <section className="typing-stage">
        <input
          ref={inputRef}
          className="typing-hidden-input"
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          value=""
          onChange={() => undefined}
          onKeyDown={handleKeyDown}
        />

        {status === "finished" ? (
          <div className="results-stage">
            <div className="results-primary">
              <div className="results-metric">
                <span className="result-label">wpm</span>
                <strong>{wpm}</strong>
              </div>
              <div className="results-metric">
                <span className="result-label">acc</span>
                <strong>{accuracy}%</strong>
              </div>
            </div>
            <div className="results-secondary">
              <div className="results-stat">
                <span className="result-label">keystrokes</span>
                <strong>{totalKeystrokes}</strong>
              </div>
              <div className="results-stat">
                <span className="result-label">correct</span>
                <strong>{correctKeystrokes}</strong>
              </div>
              <div className="results-stat">
                <span className="result-label">words</span>
                <strong>{currentWordIndex}</strong>
              </div>
              <div className="results-stat">
                <span className="result-label">time</span>
                <strong>{Math.max(1, Math.round(elapsedMs / 1000))}s</strong>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="stage-meta">
              <span>english</span>
            </div>

            <div className="word-frame" ref={wordFrameRef}>
              <div
                className="word-stream"
                aria-label="typing words"
              >
                {visibleWords.map((word, wordIndex) => {
                  const isCurrentWord = wordIndex === currentWordIndex;
                  const visibleTypedLength = Math.min(word.typed.length, word.text.length);
                  const caretSlot = isCurrentWord ? visibleTypedLength : -1;

                  return (
                    <div
                      key={word.id}
                      className={`word ${isCurrentWord ? "is-active" : ""}`}
                      ref={(element) => {
                        if (element) {
                          wordRefs.current.set(word.id, element);
                        } else {
                          wordRefs.current.delete(word.id);
                        }
                      }}
                    >
                      {word.text.split("").map((character, charIndex) => {
                        let className = "char";

                        if (charIndex < word.typed.length) {
                          className += word.typed[charIndex] === character ? " is-correct" : " is-incorrect";
                        } else if (word.submitted) {
                          className += " is-missed";
                        }

                        const attachCaret = isCurrentWord && caretSlot === charIndex;

                        return (
                          <span key={`${word.id}-${charIndex}`} className={className}>
                            {attachCaret ? <span ref={caretAnchorRef} className="caret-anchor" /> : null}
                            {character}
                          </span>
                        );
                      })}

                      {word.extras.map((character, extraIndex) => {
                        const attachCaret = isCurrentWord && word.typed.length >= word.text.length && extraIndex === word.extras.length - 1;

                        return (
                          <span key={`${word.id}-extra-${extraIndex}`} className="char extra">
                            {character}
                            {attachCaret ? <span ref={caretAnchorRef} className="caret-anchor after-extra" /> : null}
                          </span>
                        );
                      })}

                      {isCurrentWord && word.typed.length === word.text.length && word.extras.length === 0 ? (
                        <span ref={caretAnchorRef} className="caret-anchor trailing-anchor" />
                      ) : null}
                    </div>
                  );
                })}
              </div>

              {caret.visible ? (
                <div
                  className="typing-caret"
                  style={{
                    left: `${caret.left}px`,
                    top: `${caret.top}px`,
                    height: `${caret.height}px`
                  }}
                />
              ) : null}
            </div>

            <div className="live-bar">
              <span className="live-metric">{currentMetric}</span>
            </div>
          </>
        )}
      </section>

      <footer className="typing-footer">
        <span className="restart-pill">tab</span>
        <span>restart test</span>
      </footer>
    </main>
  );
}
