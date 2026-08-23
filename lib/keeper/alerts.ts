/**
 * Keeper alert delivery. Posts to ALERT_WEBHOOK_URL when configured.
 */

export async function sendAlert(
  message: string,
  webhookUrl: string | undefined = process.env.ALERT_WEBHOOK_URL,
): Promise<void> {
  console.log(`[ALERT] ${message}`);
  if (!webhookUrl) return;

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `🚨 *Keeper Bot Alert*: ${message}` }),
    });
    if (!response.ok) {
      console.error("Failed to send alert to webhook:", response.statusText);
    }
  } catch (error) {
    console.error("Error sending alert:", error);
  }
}
