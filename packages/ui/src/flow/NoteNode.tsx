import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { NOTE_STYLES, noteSpans, type NoteContent } from '../note.ts'

/**
 * Una nota dentro de React Flow: un rótulo con letra a mano que explica lo que tiene al lado. Solo se
 * lee; recibe una flecha, dibujada a mano, del nodo al que se refiere.
 */

export interface NoteNodeData extends Record<string, unknown> {
  note: NoteContent
  size: { w: number; h: number }
}

export type NoteFlowNode = Node<NoteNodeData, 'note'>

export function NoteNode({ data }: NodeProps<NoteFlowNode>) {
  const { note, size } = data
  return (
    <div
      className="note"
      data-style={note.style}
      data-current={note.current ? '' : undefined}
      data-past={note.past ? '' : undefined}
      style={{ width: size.w, minHeight: size.h }}
      role="note"
      aria-label={`${NOTE_STYLES[note.style]}: ${note.title ?? ''}`.trim()}
    >
      <Handle type="target" id="in" position={Position.Left} isConnectable={false} />
      {note.title && <strong className="note__title">{note.title}</strong>}
      <p className="note__text">
        {noteSpans(note.text).map((span, index) =>
          span.kind === 'bold' ? (
            <strong key={index}>{span.text}</strong>
          ) : span.kind === 'code' ? (
            <code key={index} className="note__code">
              {span.text}
            </code>
          ) : (
            <span key={index}>{span.text}</span>
          ),
        )}
      </p>
    </div>
  )
}
