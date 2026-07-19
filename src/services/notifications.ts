import axios from "axios";

export class NotificationService {
  private ntfyUrl: string;
  private topic: string;

  constructor(ntfyUrl: string, topic: string) {
    this.ntfyUrl = ntfyUrl;
    this.topic = topic;
  }

  async sendNotification(title: string, message: string, priority: "low" | "default" | "high" = "default") {
    try {
      await axios.post(`${this.ntfyUrl}/${this.topic}`, message, {
        headers: {
          "Title": title,
          "Priority": priority,
        },
      });
      console.log(`[ntfy] Notification sent: ${title}`);
    } catch (error) {
      console.error("Notification service failed", error);
    }
  }

  async notifyReleasesFound(title: string, count: number) {
    await this.sendNotification(
      "📥 Releases Found",
      `${count} releases found for "${title}" - approval needed`,
      "high"
    );
  }

  async notifyApproved(title: string) {
    await this.sendNotification(
      "✅ Approved",
      `${title} approved and downloading`,
      "default"
    );
  }

  async notifyReady(title: string) {
    await this.sendNotification(
      "🎬 Ready to Watch",
      `${title} is ready to watch in Jellyfin`,
      "default"
    );
  }

  async notifyError(title: string, error: string) {
    await this.sendNotification(
      "❌ Error",
      `Failed to process ${title}: ${error}`,
      "high"
    );
  }
}
