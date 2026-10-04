import type { BrowserContext } from '@playwright/test'

/** Replace only the OS picker in browser tests; writes still use real filesystem
 * handles and the production streaming sink. */
export async function useDirectFileDestination(context: BrowserContext) {
  await context.addInitScript(() => {
    const selected = async () => (await navigator.storage.getDirectory())
      .getDirectoryHandle('chosen-downloads', { create: true })
    Object.assign(window, {
      __filePickerCalls: [] as string[],
      showSaveFilePicker: async ({ suggestedName }: { suggestedName: string }) => {
        if (!navigator.userActivation.isActive) throw new Error('Save picker lost the Accept gesture')
        ;(window as unknown as { __filePickerCalls: string[] }).__filePickerCalls.push(suggestedName)
        return (await selected()).getFileHandle(suggestedName, { create: true })
      },
      showDirectoryPicker: async () => {
        if (!navigator.userActivation.isActive) throw new Error('Folder picker lost the Accept gesture')
        ;(window as unknown as { __filePickerCalls: string[] }).__filePickerCalls.push('directory')
        return selected()
      },
    })
  })
}
