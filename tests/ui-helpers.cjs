async function reveal(page, control) {
  const locator = typeof control === 'string' ? page.locator(control) : control;
  const custom = await locator.evaluate(element => element.matches('select.ui-native-select'));
  const visibleControl = custom ? locator.locator('..').locator(':scope > .ui-select-trigger') : locator;
  if (!await visibleControl.isVisible()) {
    const menuId = await locator.evaluate(element => element.closest('.ui-menu')?.id);
    if (!menuId) throw Error('Control is hidden outside a menu');
    await page.locator(`[aria-controls="${menuId}"]`).click();
    await visibleControl.waitFor({ state: 'visible' });
  }
  return locator;
}
async function selectControl(page, control, value) {
  const locator = await reveal(page, control);
  const custom = await locator.evaluate(element => element.matches('select.ui-native-select'));
  if (!custom) { await locator.selectOption(value); return; }
  const index = await locator.evaluate((element, value) => [...element.options].findIndex(option => option.value === value), value);
  if (index < 0) throw Error(`Missing option: ${value}`);
  const trigger = locator.locator('..').locator(':scope > .ui-select-trigger');
  await trigger.click();
  const id = await trigger.getAttribute('aria-controls');
  await page.locator(`#${id}`).locator('.ui-select-option').nth(index).click();
}
const controlValue = locator => locator.evaluate(element => element.value);
module.exports = { reveal, selectControl, controlValue };
