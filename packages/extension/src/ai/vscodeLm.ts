import * as vscode from 'vscode'
import type { AiProvider } from './provider.ts'

/**
 * El proveedor de la API de modelos de VS Code (`vscode.lm`): usa lo que el usuario ya tenga instalado
 * (Copilot Chat u otro), sin pedir ninguna clave. `null` si no hay ningún modelo de chat disponible.
 */
export async function vscodeLmProvider(): Promise<AiProvider | null> {
  const models = await vscode.lm.selectChatModels({})
  const model = models[0]
  if (!model) return null
  return {
    id: `vscode:${model.family}`,
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
