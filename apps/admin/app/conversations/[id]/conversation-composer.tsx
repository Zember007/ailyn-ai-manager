"use client";

import { type FormEvent, useRef, useState } from "react";
import type { TestChatSendResponse } from "../../lib/api";

interface SendErrorPayload {
  error?: string;
  status?: number;
}

export function ConversationComposer({
  conversationId,
  onSubmitStart,
  onPendingChange,
  onSuccess,
  onError
}: Readonly<{
  conversationId: string;
  onSubmitStart: (payload: { message: string; files: File[] }) => void;
  onPendingChange: (pending: boolean) => void;
  onSuccess: (payload: TestChatSendResponse) => void;
  onError: (code: string) => void;
}>) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [message, setMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const totalSizeLabel = formatBytes(files.reduce((sum, file) => sum + file.size, 0));

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedMessage = message.trim();
    const submittedFiles = [...files];

    if (!trimmedMessage && submittedFiles.length === 0) {
      return;
    }

    const payload = new FormData();
    payload.set("conversationId", conversationId);
    payload.set("message", trimmedMessage);
    for (const file of submittedFiles) {
      payload.append("files", file, file.name);
    }

    setIsSubmitting(true);
    setMessage("");
    setFiles([]);
    if (fileInputRef.current) {
      syncFileInput(fileInputRef.current, []);
    }
    onSubmitStart({ message: trimmedMessage, files: submittedFiles });
    onPendingChange(true);

    try {
      const response = await fetch("/conversations/send", {
        method: "POST",
        body: payload
      });
      if (!response.ok) {
        const errorPayload = (await response.json().catch(() => null)) as SendErrorPayload | null;
        onError(errorPayload?.error ?? "message_send_failed");
        return;
      }

      const result = (await response.json()) as TestChatSendResponse;
      onSuccess(result);
    } catch {
      onError("api_unavailable");
    } finally {
      setIsSubmitting(false);
      onPendingChange(false);
    }
  }

  return (
    <form className="composerCard" encType="multipart/form-data" onSubmit={handleSubmit}>
      <input type="hidden" name="conversationId" value={conversationId} />
      <div className="composerInputRow">
        <button
          className="composerAttach"
          disabled={isSubmitting}
          onClick={(event) => {
            event.preventDefault();
            fileInputRef.current?.click();
          }}
          type="button"
        >
          <span aria-hidden="true">+</span>
          <span>Файл</span>
        </button>
        <textarea
          name="message"
          onChange={(event) => {
            setMessage(event.target.value);
          }}
          placeholder="Напишите сообщение клиенту от имени тестового пользователя"
          value={message}
        />
        <button disabled={isSubmitting} type="submit">
          {isSubmitting ? "Отправляем..." : "Отправить"}
        </button>
      </div>
      <input
        hidden
        multiple
        name="files"
        onChange={(event) => {
          const merged = mergeFiles(files, Array.from(event.target.files ?? []));
          setFiles(merged);
          syncFileInput(event.currentTarget, merged);
        }}
        ref={fileInputRef}
        type="file"
      />
      {files.length ? (
        <div className="composerAttachments">
          <p className="muted">Выбрано файлов: {files.length}. Общий размер: {totalSizeLabel}.</p>
          <div className="attachmentPills">
            {files.map((file, index) => (
              <div className="attachmentPill pending" key={`${file.name}-${file.size}-${index}`}>
                <span>{file.name}</span>
                <button
                  disabled={isSubmitting}
                  onClick={(event) => {
                    event.preventDefault();
                    const nextFiles = files.filter((_, currentIndex) => currentIndex !== index);
                    setFiles(nextFiles);
                    if (fileInputRef.current) {
                      syncFileInput(fileInputRef.current, nextFiles);
                    }
                  }}
                  type="button"
                >
                  Убрать
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </form>
  );
}

function mergeFiles(existing: File[], added: File[]): File[] {
  const keys = new Set(existing.map((file) => `${file.name}:${file.size}:${file.lastModified}`));
  const next = [...existing];
  for (const file of added) {
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (!keys.has(key)) {
      keys.add(key);
      next.push(file);
    }
  }
  return next;
}

function syncFileInput(input: HTMLInputElement, files: File[]): void {
  const transfer = new DataTransfer();
  for (const file of files) {
    transfer.items.add(file);
  }
  input.files = transfer.files;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
