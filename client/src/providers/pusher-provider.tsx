import { PushNotification } from "@/screens/notifications/notifications-page";
import { dataServices } from "@/services/data/data-service";
import Pusher from "pusher-js";
import {
  createContext,
  ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";

interface PusherContextType {
  notifications: PushNotification[];
  unreadCount: number;
  markAsRead: (id: string) => void;
  isPushSupported: boolean;
  isPushGranted: boolean;
  requestPushPermission: () => Promise<boolean>;
  subscribeToPush: () => Promise<void>;
  unsubscribeFromPush: () => Promise<void>;
}

const PusherContext = createContext<PusherContextType | null>(null);

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY;
const PUSHER_KEY = import.meta.env.VITE_PUSHER_KEY;
const PUSHER_CLUSTER = import.meta.env.VITE_PUSHER_CLUSTER;
const IS_DEV = import.meta.env.MODE === "development";

/**
 * Provides real-time notification infrastructure using Pusher and Web Push
 *
 * Features:
 * - Pusher-based real-time notifications
 * - Web Push notification support
 * - Unread notification tracking
 * - Service worker integration
 * - Permission management
 */
export const PusherProvider = ({
  children,
  userId,
}: {
  children: ReactNode;
  userId: string;
}) => {
  const [notifications, setNotifications] = useState<PushNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isPushSupported, setIsPushSupported] = useState(false);
  const [isPushGranted, setIsPushGranted] = useState(false);
  const pusherRef = useRef<Pusher | null>(null);
  const swRegistrationRef = useRef<ServiceWorkerRegistration | null>(null);

  // Check browser support for push notifications
  useEffect(() => {
    const supported =
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window &&
      Boolean(VAPID_PUBLIC_KEY);

    setIsPushSupported(supported);
    setIsPushGranted(Notification.permission === "granted");
  }, []);

  // Service Worker Registration and Setup
  useEffect(() => {
    if (!isPushSupported) return;

    const registerServiceWorker = async () => {
      try {
        const registration = await navigator.serviceWorker.register("/sw.js", {
          scope: "/",
          updateViaCache: IS_DEV ? "none" : "imports",
        });

        const readyRegistration = await navigator.serviceWorker.ready;
        swRegistrationRef.current = readyRegistration;

        // Send configuration to service worker
        readyRegistration.active?.postMessage({
          type: "SET_CONFIG",
          config: {
            backendUrl: IS_DEV
              ? "https://nest.dev.lo"
              : "https://api.mmedic.valentinee.dev",
            vapidKey: VAPID_PUBLIC_KEY,
          },
        });

        navigator.serviceWorker.addEventListener("message", handleSWMessage);

        if (Notification.permission === "granted") {
          await subscribeToPushInternal(readyRegistration);
        }
      } catch (error) {
        console.error("Service Worker registration failed:", error);
      }
    };

    registerServiceWorker();

    return () => {
      navigator.serviceWorker.removeEventListener("message", handleSWMessage);
    };
  }, [isPushSupported, userId]);

  /**
   * Handles messages from Service Worker
   * @param event - Message event from service worker
   */
  const handleSWMessage = (event: MessageEvent) => {
    switch (event.data.type) {
      case "NOTIFICATION_CLICKED":
        if (event.data.data.id) markAsRead(event.data.data.id);
        break;

      case "SHOW_TOAST":
        if (document.visibilityState === "visible" && isPushGranted) {
          toast.success(event.data.data.message, {
            description: event.data.data.title,
            duration: 4000,
          });
        }
        break;

      default:
        break;
    }
  };

  // Pusher Connection Management
  useEffect(() => {
    if (!PUSHER_KEY || !PUSHER_CLUSTER || !userId) return;

    pusherRef.current?.disconnect();

    const pusher = new Pusher(PUSHER_KEY, {
      cluster: PUSHER_CLUSTER,
      forceTLS: true,
    });
    pusherRef.current = pusher;

    const channel = pusher.subscribe(`user-${userId}`);

    channel.bind("new-notification", (data: PushNotification) => {
      // Show toast only when app is visible and push not enabled
      if (!isPushGranted && document.visibilityState === "visible") {
        toast.success(data.message, { description: data.title });
      }

      setNotifications((prev) => [data, ...prev]);
      setUnreadCount((prev) => prev + 1);
    });

    return () => {
      channel.unbind_all();
      pusher.unsubscribe(`user-${userId}`);
      pusher.disconnect();
    };
  }, [userId, isPushGranted]);

  /**
   * Requests push notification permission from user
   * @returns Promise resolving to permission status
   */
  const requestPushPermission = async (): Promise<boolean> => {
    if (!isPushSupported) {
      toast.error("Push notifications not supported");
      return false;
    }

    try {
      const permission = await Notification.requestPermission();
      const granted = permission === "granted";
      setIsPushGranted(granted);

      if (granted && swRegistrationRef.current) {
        await subscribeToPushInternal(swRegistrationRef.current);
        toast.success("Push notifications enabled");
      }

      return granted;
    } catch (error) {
      console.error("Permission request failed:", error);
      return false;
    }
  };

  /**
   * Internal push subscription handler
   * @param registration - ServiceWorkerRegistration instance
   */
  const subscribeToPushInternal = async (
    registration: ServiceWorkerRegistration
  ) => {
    try {
      // Check for existing subscription
      let subscription = await registration.pushManager.getSubscription();

      // Renew if existing subscription is invalid
      if (subscription) {
        try {
          await sendSubscriptionToServer(subscription);
          return;
        } catch {
          await subscription.unsubscribe();
          subscription = null;
        }
      }

      // Create new subscription
      if (!subscription) {
        const vapidKeyArray = urlBase64ToUint8Array(VAPID_PUBLIC_KEY!);
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: vapidKeyArray,
        });
      }

      await sendSubscriptionToServer(subscription);
    } catch (error) {
      console.error("Push subscription failed:", error);
      toast.error("Failed to enable push notifications");
    }
  };

  /**
   * Public method to subscribe to push notifications
   */
  const subscribeToPush = async (): Promise<void> => {
    if (swRegistrationRef.current) {
      await subscribeToPushInternal(swRegistrationRef.current);
    }
  };

  /**
   * Converts VAPID key from base64 to Uint8Array
   * @param base64String - VAPID public key
   * @returns Uint8Array representation of key
   */
  const urlBase64ToUint8Array = (base64String: string): Uint8Array<ArrayBuffer> => {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding)
      .replace(/-/g, "+")
      .replace(/_/g, "/");

    const rawData = window.atob(base64);
    const buffer = new Uint8Array(rawData.length);

    for (let i = 0; i < rawData.length; ++i) {
      buffer[i] = rawData.charCodeAt(i);
    }

    return buffer;
  };

  /**
   * Sends push subscription to backend server
   * @param subscription - PushSubscription object
   */
  const sendSubscriptionToServer = async (subscription: PushSubscription) => {
    const subData = subscription.toJSON();

    if (!subData.endpoint || !subData.keys) {
      throw new Error("Invalid subscription data");
    }

    await dataServices.api.notifications.subscribe().post.call({
      json: {
        userId,
        subscription: {
          endpoint: subData.endpoint,
          keys: {
            p256dh: subData.keys.p256dh,
            auth: subData.keys.auth,
          },
        },
      },
    });
  };

  /**
   * Unsubscribes from push notifications
   */
  const unsubscribeFromPush = async (): Promise<void> => {
    if (!swRegistrationRef.current) return;

    try {
      const subscription =
        await swRegistrationRef.current.pushManager.getSubscription();

      if (subscription) {
        await subscription.unsubscribe();
        await dataServices.api.notifications
          .unsubscribe()
          .post.call({ json: { userId, endpoint: subscription.endpoint } }),
          setIsPushGranted(false);
        toast.success("Push notifications disabled");
      }
    } catch (error) {
      console.error("Unsubscribe failed:", error);
    }
  };

  /**
   * Marks notification as read
   * @param id - Notification ID to mark as read
   */
  const markAsRead = (id: string): void => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n))
    );
    setUnreadCount((prev) => (prev > 0 ? prev - 1 : 0));
  };

  return (
    <PusherContext.Provider
      value={{
        notifications,
        unreadCount,
        markAsRead,
        isPushSupported,
        isPushGranted,
        requestPushPermission,
        subscribeToPush,
        unsubscribeFromPush,
      }}
    >
      {children}
    </PusherContext.Provider>
  );
};

/**
 * Hook for accessing Pusher context
 * @returns Pusher context object
 * @throws Error if used outside Provider
 */
export const usePusher = () => {
  const context = useContext(PusherContext);
  if (!context) {
    throw new Error("usePusher must be used within a PusherProvider");
  }
  return context;
};
