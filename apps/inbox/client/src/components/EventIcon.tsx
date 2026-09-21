import {
  Archive,
  Ban,
  Banknote,
  Check,
  CheckCheck,
  ChevronRight,
  Clock,
  CreditCard,
  FileText,
  type LucideIcon,
  MessageCircleQuestionMark,
  Package,
  PackageCheck,
  Receipt,
  Reply,
  RotateCcw,
  ShieldCheck,
  ShieldOff,
  UserX,
  X,
} from "lucide-react";

/** One icon per transition event, so the phone's action bar can be icons and still be understood. */
const ICONS: Record<string, LucideIcon> = {
  confirm: Check,
  accept: Check,
  approve: Check,
  propose: Clock,
  decline: X,
  reject: X,
  cancel: Ban,
  cancel_by_business: Ban,
  request_info: MessageCircleQuestionMark,
  quote: FileText,
  record_payment: CreditCard,
  refund: Banknote,
  request_payment: Receipt,
  start_fulfilment: Package,
  fulfil: PackageCheck,
  complete: CheckCheck,
  no_show: UserX,
  close: Archive,
  mark_spam: ShieldOff,
  unspam: ShieldCheck,
  reopen: RotateCcw,
  answer: Reply,
};

export function EventIcon({ event, className = "icon" }: { event: string; className?: string | undefined }) {
  const Icon = ICONS[event] ?? ChevronRight;
  return <Icon className={className} aria-hidden="true" />;
}
