export async function persistBeforeSubmit<T>(persistIntent: () => Promise<void>, submit: () => Promise<T>): Promise<T> {
  await persistIntent();
  return submit();
}
