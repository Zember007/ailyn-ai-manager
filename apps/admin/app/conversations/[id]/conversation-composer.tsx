"use client";

import { useRef, useState } from "react";

export function ConversationComposer({ conversationId }: Readonly<{ conversationId: string }>) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const totalSizeLabel = formatBytes(files.reduce((sum, file) => sum + file.size, 0));

  return (
    <form className="composerCard" action="/conversations/send" encType="multipart/form-data" method="post">
      <input type="hidden" name="conversationId" value={conversationId} />
      <div className="composerInputRow">
        <button
          className="composerAttach"
          onClick={(event) => {
            event.preventDefault();
            fileInputRef.current?.click();
          }}
          type="button"
        >
          <span aria-hidden="true">+</span>
          <span>Файл</span>
        </button>
        <textarea name="message" placeholder="Напишите сообщение клиенту от имени тестового пользователя" />
        <button type="submit">Отправить</button>
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
