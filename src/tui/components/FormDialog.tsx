import type { InputRenderable, TextareaRenderable } from '@opentui/core';
import { useBindings } from '@opentui/keymap/react';
import { useEffect, useRef, useState } from 'react';
import type { FormQuestion, Theme } from '../state.js';
import { Modal } from './Modal.js';

export function FormDialog({ questions, preamble, theme, width, height, zh, onComplete, onCancel }: {
  questions: FormQuestion[];
  preamble: string[];
  theme: Theme;
  width: number;
  height: number;
  zh: boolean;
  onComplete: (answers: string[]) => void;
  onCancel: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<string[]>([]);
  const [value, setValue] = useState(questions[0]?.fallback || '');
  const [validation, setValidation] = useState<string>();
  const [validating, setValidating] = useState(false);
  const valueRef = useRef(value);
  const inputRef = useRef<InputRenderable>(null);
  const textareaRef = useRef<TextareaRenderable>(null);
  const question = questions[index];

  useBindings(() => ({
    priority: 400,
    bindings: [
      { key: 'escape', cmd: () => { onCancel(); return true; } },
      { key: 'ctrl+c', cmd: () => { onCancel(); return true; } },
    ],
  }), [onCancel]);

  useEffect(() => {
    if (question?.multiline) textareaRef.current?.focus();
    else inputRef.current?.focus();
  }, [index, question?.multiline]);

  if (!question) return null;
  const questionLabel = typeof question.label === 'function' ? question.label(answers) : question.label;

  const submit = async (raw: string) => {
    const answer = raw.trim() || question.fallback || '';
    setValidation(undefined);
    if (question.validate) {
      setValidating(true);
      const issue = await question.validate(answer, answers);
      setValidating(false);
      if (issue) { setValidation(issue); return; }
    }
    const next = [...answers, answer];
    if (index === questions.length - 1) { onComplete(next); return; }
    const nextIndex = index + 1;
    const nextValue = questions[nextIndex]?.fallback || '';
    setAnswers(next);
    setIndex(nextIndex);
    setValue(nextValue);
    setValidation(undefined);
    valueRef.current = nextValue;
  };

  return (
    <Modal title={zh ? '输入' : 'Input'} theme={theme} width={width} height={height}>
      <box flexDirection="column" flexGrow={1} minHeight={0}>
        <scrollbox flexGrow={1} minHeight={0} viewportCulling>
          {preamble.map((line, lineIndex) => <text key={`pre-${lineIndex}`} fg={lineIndex === 0 ? theme.warn : theme.muted} wrapMode="word">{line}</text>)}
          {preamble.length ? <text> </text> : null}
          {answers.map((answer, answerIndex) => (
            <box key={`answer-${answerIndex}`} flexDirection="column" marginBottom={1}>
              <text fg={theme.muted} wrapMode="word">{typeof questions[answerIndex].label === 'function' ? questions[answerIndex].label(answers.slice(0, answerIndex)) : questions[answerIndex].label}</text>
              <text fg={theme.text} wrapMode="word">{questions[answerIndex].sensitive ? '••••••••' : answer}</text>
            </box>
          ))}
        </scrollbox>
        <box flexDirection="column" flexShrink={0} marginTop={1}>
          <text fg={theme.accent} wrapMode="word"><b>{index + 1}/{questions.length} · {questionLabel}</b></text>
          {question.multiline ? (
            <textarea
              key={`textarea-${index}`}
              ref={textareaRef}
              height={Math.max(4, Math.min(8, height - 14))}
              initialValue={value}
              placeholder={question.fallback || ''}
              wrapMode="word"
              backgroundColor={theme.panelAlt}
              focusedBackgroundColor={theme.selected}
              textColor={theme.text}
              focusedTextColor={theme.selectedText}
              cursorColor={theme.accent}
              keyBindings={[{ name: 'return', ctrl: true, action: 'submit' }]}
              onContentChange={() => { valueRef.current = textareaRef.current?.plainText || ''; }}
              onSubmit={() => void submit(textareaRef.current?.plainText || valueRef.current)}
              focused
            />
          ) : (
            <input
              key={`input-${index}`}
              ref={inputRef}
              value={value}
              placeholder={question.fallback || ''}
              backgroundColor={theme.panelAlt}
              focusedBackgroundColor={theme.selected}
              textColor={theme.text}
              focusedTextColor={theme.selectedText}
              cursorColor={theme.accent}
              onInput={(next) => { valueRef.current = next; setValue(next); }}
              onSubmit={() => void submit(inputRef.current?.value || valueRef.current)}
              focused
            />
          )}
          {validation ? <text fg={theme.bad} wrapMode="word">{validation}</text> : null}
          {validating ? <text fg={theme.warn}>{zh ? '正在校验…' : 'Validating…'}</text> : null}
          <text fg={theme.muted}>{question.multiline ? (zh ? 'Ctrl+Enter 下一步 · Esc 取消' : 'Ctrl+Enter next · Esc cancel') : (zh ? 'Enter 下一步 · Esc 取消' : 'Enter next · Esc cancel')}</text>
        </box>
      </box>
    </Modal>
  );
}
