import type { InputRenderable, TextareaRenderable } from '@opentui/core';
import { useBindings } from '@opentui/keymap/react';
import { useEffect, useRef, useState } from 'react';
import type { FormQuestion, Theme } from '../state.js';
import { initialQuestionState, nextTextValue, optionAnswer, toggleSelectedOption } from '../form-model.js';
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
  const initial = initialQuestionState(questions[0]);
  const [value, setValue] = useState(initial.value);
  const [pristine, setPristine] = useState(initial.pristine);
  const [optionIndex, setOptionIndex] = useState(initial.optionIndex);
  const [selectedOptions, setSelectedOptions] = useState(initial.selectedOptions);
  const [validation, setValidation] = useState<string>();
  const [validating, setValidating] = useState(false);
  const valueRef = useRef(initial.value);
  const optionIndexRef = useRef(initial.optionIndex);
  const selectedOptionsRef = useRef(initial.selectedOptions);
  const inputRef = useRef<InputRenderable>(null);
  const textareaRef = useRef<TextareaRenderable>(null);
  const question = questions[index];
  const options = question?.options || [];
  const labels = question?.optionLabels || options;

  const applyQuestionState = (nextIndex: number) => {
    const state = initialQuestionState(questions[nextIndex]);
    valueRef.current = state.value;
    optionIndexRef.current = state.optionIndex;
    selectedOptionsRef.current = state.selectedOptions;
    setValue(state.value);
    setPristine(state.pristine);
    setOptionIndex(state.optionIndex);
    setSelectedOptions(state.selectedOptions);
    setValidation(undefined);
  };

  const submit = async (raw: string) => {
    const answer = raw.trim() || question?.fallback || '';
    setValidation(undefined);
    if (question?.validate) {
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
    applyQuestionState(nextIndex);
  };

  const moveOption = (delta: number) => {
    if (!options.length) return;
    const next = (optionIndexRef.current + options.length + delta) % options.length;
    optionIndexRef.current = next;
    setOptionIndex(next);
  };

  const toggleCurrent = () => {
    const option = options[optionIndexRef.current];
    if (!option) return;
    const next = toggleSelectedOption(selectedOptionsRef.current, option);
    selectedOptionsRef.current = next;
    setSelectedOptions(next);
  };

  useBindings(() => ({
    priority: 400,
    bindings: [
      { key: 'escape', cmd: () => { onCancel(); return true; } },
      { key: 'ctrl+c', cmd: () => { onCancel(); return true; } },
      { key: 'ctrl+u', cmd: () => { if (!question?.options) { valueRef.current = ''; setValue(''); setPristine(false); } return true; } },
      ...(!question?.options ? [] : [
        { key: 'left', cmd: () => { moveOption(-1); return true; } },
        { key: 'up', cmd: () => { moveOption(-1); return true; } },
        { key: 'right', cmd: () => { moveOption(1); return true; } },
        { key: 'down', cmd: () => { moveOption(1); return true; } },
        ...(question.multiSelect ? [{ key: 'space', cmd: () => { toggleCurrent(); return true; } }] : []),
        { key: 'return', cmd: () => { void submit(optionAnswer(question, optionIndexRef.current, selectedOptionsRef.current)); return true; } },
      ]),
    ],
  }), [onCancel, question, answers, index, options]);

  useEffect(() => {
    if (question?.multiline) textareaRef.current?.focus();
    else if (!question?.options) inputRef.current?.focus();
  }, [index, question?.multiline, question?.options]);

  if (!question) return null;
  const questionLabel = typeof question.label === 'function' ? question.label(answers) : question.label;
  const columnOptions = question.optionsLayout === 'column';

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
            <box flexDirection={columnOptions ? 'column' : 'row'} flexWrap={columnOptions ? 'no-wrap' : 'wrap'} gap={1} marginTop={1}>
              {options.map((option, position) => {
                const active = position === optionIndex;
                const selected = question.multiSelect ? selectedOptions.includes(option) : active;
                return (
                  <box key={option} flexDirection="column" width={columnOptions ? '100%' : undefined} paddingLeft={1} paddingRight={1} backgroundColor={active ? theme.selected : theme.panelAlt} onMouseDown={() => {
                    optionIndexRef.current = position;
                    setOptionIndex(position);
                    if (question.multiSelect) {
                      const next = toggleSelectedOption(selectedOptionsRef.current, option);
                      selectedOptionsRef.current = next;
                      setSelectedOptions(next);
                    } else void submit(option);
                  }}>
                    <text fg={active ? theme.selectedText : selected ? theme.good : theme.text} wrapMode="word">{question.multiSelect ? `${selected ? '✓' : '○'} ${labels[position] || option}` : labels[position] || option}</text>
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
              onInput={(incoming) => {
                const next = nextTextValue(valueRef.current, incoming, pristine);
                valueRef.current = next;
                setValue(next);
                setPristine(false);
              }}
              onSubmit={() => void submit(inputRef.current?.value || valueRef.current)}
              focused
            />
          )}
          {validation ? <text fg={theme.bad} wrapMode="word">{validation}</text> : null}
          {validating ? <text fg={theme.warn}>{zh ? '正在校验…' : 'Validating…'}</text> : null}
          <text fg={theme.muted}>{question.options
            ? (question.multiSelect ? (zh ? '方向键选择 · Space 勾选 · Enter 确认 · 鼠标点击切换' : 'Arrows choose · Space toggle · Enter confirm · click to toggle') : (zh ? '方向键选择 · Enter 确认 · 鼠标点击' : 'Arrows choose · Enter confirm · click'))
            : question.multiline
              ? (zh ? 'Ctrl+Enter 下一步 · Ctrl+U 清空 · Esc 取消' : 'Ctrl+Enter next · Ctrl+U clear · Esc cancel')
              : (zh ? 'Enter 下一步 · Ctrl+U 清空 · Esc 取消' : 'Enter next · Ctrl+U clear · Esc cancel')}</text>
        </box>
      </box>
    </Modal>
  );
}
