import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'

const screenshot = async (page: Page, targetPage: TargetPage) => {
  await page.goto(targetPage.path)

  await expect(page).toHaveScreenshot({ fullPage: true })
}

interface TargetPage {
  name: string
  path: string
}

const targetPage: TargetPage = {
  name: 'top',
  path: '/',
}

test(targetPage.name, async ({ page }) => {
  await screenshot(page, targetPage)
})
