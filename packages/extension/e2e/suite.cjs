/* eslint-disable */
// Las pruebas de extremo a extremo: corren DENTRO de un VS Code de verdad, con la extensión instalada
// desde su `.vsix`, y escriben lo que vieron en un JSON que lee `run.mjs`.
const vscode = require('vscode')
const fs = require('node:fs')
const path = require('node:path')

const wait = async (condition, ms = 20000) => {
  const until = Date.now() + ms
  while (!(await condition())) {
    if (Date.now() > until) throw new Error('se agotó la espera: ' + condition.toString())
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

exports.run = async () => {
  const result = { checks: {}, error: null }
  const check = (name, value) => {
    result.checks[name] = value
  }
  let api = null
  try {
    const extension = vscode.extensions.getExtension('prysel.prysel-extension')
    check('instalada', extension !== undefined)
    check('versión', extension?.packageJSON.version)
    check('confianza', vscode.workspace.isTrusted)
    api = await extension.activate()
    check('activada', extension.isActive)
    const commands = await vscode.commands.getCommands(true)
    check(
      'comandos',
      ['prysel.openCanvas', 'prysel.runAll', 'prysel.interrupt', 'prysel.restart'].filter((c) =>
        commands.includes(c),
      ),
    )

    const file = path.join(process.env.PRYSEL_TEST_DIR, 'demo.py')
    fs.writeFileSync(
      file,
      'a = 21\nb = a * 2\nprint(b)\nxs = [1, 2, 3]\nfor i in range(3):\n    a += i\n',
    )
    const doc = await vscode.workspace.openTextDocument(file)
    await vscode.window.showTextDocument(doc)
    check('lenguaje', doc.languageId)

    await vscode.workspace
      .getConfiguration('prysel')
      .update('python', process.env.PRYSEL_PYTHON, vscode.ConfigurationTarget.Global)

    // El lienzo: un webview de verdad que carga dist/webview y avisa de que arrancó.
    await vscode.commands.executeCommand('prysel.openCanvas')
    await wait(() => api.state().webviewsReady > 0)
    check('webview cargó', api.state().webviewsReady)
    check('parser', api.state().parser)
    await wait(() => api.state().states.length > 0)
    check('antes de ejecutar', api.state().states)

    await vscode.commands.executeCommand('prysel.runAll')
    await wait(() => api.state().kernel === 'idle' || api.state().kernel === 'dead')
    const after = api.state()
    check('motor', after?.kernel)
    check('problema', after?.problem)
    check('estados', after?.states)
    check('salida', after?.stdout)

    // Editar el archivo deja desactualizado lo que depende de lo editado.
    const edit = new vscode.WorkspaceEdit()
    edit.replace(doc.uri, new vscode.Range(0, 4, 0, 6), '10')
    await vscode.workspace.applyEdit(edit)
    await wait(() => api.state().states.some((s) => s !== 'fresh'))
    check('tras editar', api.state().states)

    await vscode.commands.executeCommand('prysel.runAll')
    await wait(() => api.state().states.every((s) => s === 'fresh'))
    check('tras volver a ejecutar', api.state().states)
    check('salida nueva', api.state().stdout)

    await vscode.commands.executeCommand('prysel.restart')
    await wait(() => api.state().kernel === 'stopped')
    check('tras reiniciar', api.state().states)
  } catch (error) {
    result.error = String(error && error.stack ? error.stack : error)
    // Lo que se veía cuando falló: es lo primero que hace falta para entender por qué.
    result.state = api ? api.state() : null
  }
  fs.writeFileSync(process.env.PRYSEL_TEST_OUT, JSON.stringify(result, null, 2))
  if (result.error) throw new Error(result.error)
}
