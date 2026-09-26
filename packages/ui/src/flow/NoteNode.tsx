import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { NOTE_STYLES, noteSpans, type NoteContent } from '../note.ts'

/**
 * Una nota dentro de React Flow: un rótulo con letra a mano que explica lo que tiene al lado; recibe una
 * flecha, dibujada a mano, del nodo al que se refiere. El `código` que menciona ilumina, al pasar el
 * puntero, el nodo del diagrama del que habla. Si el lienzo lo permite, se arrastra a mano (y con doble
 * clic vuelve a su sitio).
 */

export interface NoteNodeData extends Record<string, unknown> {
  note: NoteContent
  size: { w: number; h: number }
  /** Se pasa el puntero por un trozo de código de la nota (`null` al salir): el lienzo ilumina su nodo. */
  onHint?: (code: string | null) => void
  /** La nota se arrastró a mano y se quiere devolver al sitio que le da el margen. */
  onReset?: () => void
  /** Si el código de un trozo nombra algo que está en el diagrama (y por tanto se puede iluminar). */
  knows?: (code: string) => boolean
  /** Está fuera del sitio que le da el margen (se arrastró a mano): con doble clic vuelve. */
  moved?: boolean
}

export type NoteFlowNode = Node<NoteNodeData, 'note'>

export function NoteNode({ data }: NodeProps<NoteFlowNode>) {
  const { note, size, onHint, onReset, knows, moved } = data
  return (
    <div
      className="note"
      data-style={note.style}
      data-current={note.current ? '' : undefined}
      data-past={note.past ? '' : undefined}
      data-moved={moved ? '' : undefined}
      style={{ width: size.w, minHeight: size.h }}
      role="note"
      aria-label={`${NOTE_STYLES[note.style]}: ${note.title ?? ''}`.trim()}
      {...(onReset && moved
        ? {
            title: 'Doble clic: devolverla a su sitio',
            onDoubleClick: onReset,
          }
        : {})}
    >
      <Handle type="target" id="in" position={Position.Left} isConnectable={false} />
      {note.title && <strong className="note__title">{note.title}</strong>}
      <p className="note__text">
        {noteSpans(note.text).map((span, index) =>
          span.kind === 'bold' ? (
            <strong key={index}>{span.text}</strong>
          ) : span.kind === 'code' ? (
            <code
              key={index}
              className="note__code"
              // Solo lo que nombra algo del diagrama se ilumina: lo demás es código sin más.
              {...(onHint && knows?.(span.text)
                ? {
                    'data-links': '',
                    onMouseEnter: () => {
                      onHint(span.text)
                    },
                    onMouseLeave: () => {
                      onHint(null)
                    },
                  }
                : {})}
            >
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
