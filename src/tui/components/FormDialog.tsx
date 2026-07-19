import type { InputRenderable, TextareaRenderable } from '@opentui/core';
import { useBindings } from '@opentui/keymap/react';
import { useEffect, useMemo, useRef, useState } from 'react';
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
  const [pristine, setPristine] = useState(true);
  const [optionIndex, setOptionIndex] = useState(() => Math.max(0, questions[0]?.options?.indexOf(questions[0]?.fallback || '') ?? 0));
  const [selectedOptions, setSelectedOptions] = useState<string[]>(() => questions[0]?.multiSelect && questions[0]?.fallback ? questions[0].fallback.split(',').map((item) => item.trim()).filter(Boolean) : []);
  const valueRef = useRef(value);
  const inputRef = useRef<InputRenderable>(null);
  const textareaRef = useRef<TextareaRenderable>(null);
  const question = questions[index];
  const options = question?.options || [];
  const labels = question?.optionLabels || options;

  const resetForQuestion = (nextIndex: number) => {
    const nextQuestion = questions[nextIndex];
    const nextValue = nextQuestion?.fallback || '';
    setValue(nextValue);
    valueRef.current = nextValue;
    setPristine(true);
    setValidation(undefined);
    const fallbackIndex = nextQuestion?.options?.indexOf(nextQuestion.fallback || '') ?? -1;
    setOptionIndex(Math.max(0, fallbackIndex));
    setSelectedOptions(nextQuestion?.multiSelect && nextQuestion.fallback ? nextQuestion.fallback.split(',').map((item) => item.trim()).filter(Boolean) : []);
  };

  useBindings(() => ({
    priority: 400,
    bindings: [
      { key: 'escape', cmd: () => { onCancel(); return true; } },
      { key: 'ctrl+c', cmd: () => { onCancel(); return true; } },
      { key: 'ctrl+u', cmd: () => { if (!question?.options) { setValue(''); valueRef.current = ''; setPristine(false); } return true; } },
      ...(!question?.options ? [] : [
        { key: 'left', cmd: () => { setOptionIndex((current) => (current + options.length - 1) % options.length); return true; } },
        { key: 'right', cmd: () => { setOptionIndex((current) => (current + 1) % options.length); return true; } },
        { key: 'up', cmd: () => { setOptionIndex((current) => (current + options.length - 1) % options.length); return true; } },
        { key: 'down', cmd: () => { setOptionIndex((current) => (current + 1) % options.length); return true; } },
        ...(question.multiSelect ? [{ key: 'space', cmd: () => { const option = options[optionIndex]; setSelectedOptions((current) => current.includes(option) ? current.filter((item) => item !== option) : [...current, option]); return true; } }] : []),
        { key: 'return', cmd: () => { void submit(question.multiSelect ? selectedOptions.join(',') : options[optionIndex] || question.fallback || ''); return true; } },
      ]),
    ],
  }), [onCancel, question, options, optionIndex]);

  useEffect(() => {
    if (question?.multiline) textareaRef.current?.focus();
    else if (!question?.options) inputRef.current?.focus();
  }, [index, question?.multiline, question?.options]);

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
    setAnswers(next);
    setIndex(nextIndex);
    resetForQuestion(nextIndex);
  };

  const optionAnswer = useMemo(() => {
    if (!question?.options) return '';
    if (question.multiSelect) return selectedOptions.join(',');
    return options[optionIndex] || question.fallback || '';
  }, [question, selectedOptions, options, optionIndex]);

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
          {question.options ? (
            <box flexDirection="row" flexWrap="wrap" gap={1} marginTop={1}>
              {options.map((option, optionPosition) => {
                const active = optionPosition === optionIndex;
                const selected = question.multiSelect ? selectedOptions.includes(option) : active;
                return (
                  <box key={option} paddingLeft={1} paddingRight={1} backgroundColor={active ? theme.selected : theme.panelAlt} onMouseDown={() => {
                    setOptionIndex(optionPosition);
                    if (question.multiSelect) setSelectedOptions((current) => current.includes(option) ? current.filter((item) => item !== option) : [...current, option]);
                    else void submit(option);
                  }}>
                    <text fg={active ? theme.selectedText : selected ? theme.good : theme.text}>{question.multiSelect ? `${selected ? '✓' : '○'} ${labels[optionPosition] || option}` : labels[optionPosition] || option}</text>
                  </box>
                );
              })}
            </box>
          ) : question.multiline ? (
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
              onContentChange={() => { valueRef.current = textareaRef.current?.plainText || ''; setPristine(false); }}
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
              onInput={(next) => {
                const normalized = pristine && value && next.startsWith(value) ? next.slice(value.length) : next;
                valueRef.current = normalized;
                setValue(normalized);
                setPristine(false);
              }}
              onSubmit={() => void submit(inputRef.current?.value || valueRef.current)}
              focused
            />
          )}
          {validation ? <text fg={theme.bad} wrapMode="word">{validation}</text> : null}
          {validating ? <text fg={theme.warn}>{zh ? '正在校验…' : 'Validating…'}</text> : null}
          <text fg={theme.muted}>{question.options
            ? (question.multiSelect ? (zh ? '←/→ 选择 · Space 勾选 · Enter 确认 · 鼠标点击切换' : '←/→ choose · Space toggle · Enter confirm · click to toggle') : (zh ? '←/→ 选择 · Enter 确认 · 鼠标点击' : '←/→ choose · Enter confirm · click'))
            : question.multiline
              ? (zh ? 'Ctrl+Enter 下一步 · Ctrl+U 清空 · Esc 取消' : 'Ctrl+Enter next · Ctrl+U clear · Esc cancel')
              : (zh ? 'Enter 下一步 · Ctrl+U 清空 · Esc 取消' : 'Enter next · Ctrl+U clear · Esc cancel')}</text>
        </box>
      </box>
    </Modal>
  );
}
