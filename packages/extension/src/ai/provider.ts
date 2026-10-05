/**
 * Un proveedor de modelo: lo único que la generación necesita es mandar un texto y recibir un texto. Quién
 * hay detrás (`vscode.lm`, la API de Anthropic) no le importa a nadie más que a quien lo implementa.
 */
export interface AiRequest {
  system: string
  prompt: string
  /** Tope de lo que se pide generar: una lección corta no necesita mucho. */
  maxTokens?: number
}

export interface AiProvider {
  /** Un nombre corto para mostrar y para la caché (`vscode:gpt-4o`, `anthropic:claude-sonnet-5`). */
  readonly id: string
  generate(request: AiRequest): Promise<string>
  /**
   * Lo mismo, viendo llegar el texto trozo a trozo (`onText`) y pudiendo cortarlo a mitad (`signal`).
   * Devuelve el texto entero (o lo que llevara al cortarse). Sin él, el texto llega de una vez.
   */
  stream?(
    request: AiRequest,
    onText: (delta: string) => void,
    signal?: AbortSignal,
  ): Promise<string>
}

/** Por qué no hay un proveedor listo: ninguno configurado, o el que se pidió no está disponible. */
export class AiUnavailableError extends Error {}
