import * as vscode from 'vscode'
import type { AiProvider } from './provider.ts'

/**
 * El proveedor de la API de modelos de VS Code (`vscode.lm`): usa lo que el usuario ya tenga instalado
 * (Copilot Chat u otro), sin pedir ninguna clave. `null` si no hay ningún modelo de chat disponible.
 */
export async function vscodeLmProvider(wanted?: string): Promise<AiProvider | null> {
  const models = await vscode.lm.selectChatModels({})
  // El que se eligió (por su id o su familia), si sigue instalado; si no, el primero que haya.
  const model = models.find((m) => m.id === wanted || m.family === wanted) ?? models[0]
  if (!model) return null
  return {
    id: `vscode:${model.family}`,
    async stream({ system, prompt }, onText, signal) {
      const cancel = new vscode.CancellationTokenSource()
      signal?.addEventListener('abort', () => {
        cancel.cancel()
      })
      const messages = [vscode.LanguageModelChatMessage.User(`${system}\n\n${prompt}`)]
      let text = ''
      try {
        const request = await model.sendRequest(messages, {}, cancel.token)
        for await (const chunk of request.text) {
          if (signal?.aborted) break
          text += chunk
          onText(chunk)
        }
      } catch (error) {
        if (!signal?.aborted) throw error
      }
      return text
    },
    async generate({ system, prompt }) {
      // La API no tiene un mensaje de sistema propio: se antepone al primer mensaje del usuario.
      const messages = [vscode.LanguageModelChatMessage.User(`${system}\n\n${prompt}`)]
      const request = await model.sendRequest(
        messages,
        {},
        new vscode.CancellationTokenSource().token,
      )
      let text = ''
      for await (const chunk of request.text) text += chunk
      return text
    },
  }
}
