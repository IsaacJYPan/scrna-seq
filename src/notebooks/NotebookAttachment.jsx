import React, { useState } from 'react';
import { defaultUrlTransform } from 'react-markdown';
import { ImportedNotebookMimeView } from './ImportedNotebookOutputs';

/** Resolve an inert cell-local name, never a URL or a filesystem path. */
export function notebookAttachmentBundle(src, attachments) {
  if (typeof src !== 'string' || !/^attachment:/i.test(src) || !attachments || typeof attachments !== 'object' || Array.isArray(attachments)) return null;
  const name = src.slice('attachment:'.length);
  let descriptor = Object.getOwnPropertyDescriptor(attachments, name);
  if (!descriptor) {
    let decoded;
    try { decoded = decodeURIComponent(name); } catch { return null; }
    descriptor = Object.getOwnPropertyDescriptor(attachments, decoded);
  }
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : null;
}

function AttachmentPreview({ src, alt, attachments }) {
  const [open, setOpen] = useState(false);
  const bundle = notebookAttachmentBundle(src, attachments);
  if (!bundle) return <span className="text-xs text-textMuted">Image reference: {alt || 'image'} (images are not loaded automatically)</span>;
  return <span className="inline-block max-w-full">
    <button type="button" className="text-sm text-primary underline" aria-expanded={open} onClick={() => setOpen(current => !current)}>{open ? 'Hide' : 'Preview'} imported attachment{alt ? `: ${alt}` : ''}</button>
    {open && <span className="mt-2 block"><ImportedNotebookMimeView bundle={bundle} label={alt || 'Imported attachment'} inline /></span>}
  </span>;
}

export function CellNotebookImage(props) {
  return <AttachmentPreview key={props.src} {...props} />;
}

export function notebookMarkdownUrlTransform(url) {
  return typeof url === 'string' && /^attachment:/i.test(url) ? url : defaultUrlTransform(url);
}

/** Pass to ReactMarkdown together with skipHtml and notebookMarkdownUrlTransform. */
export function notebookMarkdownComponents(attachments) {
  return { img: ({ src, alt }) => <CellNotebookImage src={src} alt={alt} attachments={attachments} /> };
}
