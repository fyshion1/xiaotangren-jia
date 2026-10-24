// Optional feature contract and unavailable fallback; contains no feature implementation.
import { type CardDisplayRule } from '../lib/cardDisplay';
/** Card styles and scripts are confined to an opaque-origin sandbox. */
type Props = {
    html: string;
    title?: string;
    defaultOpen?: boolean;
    rules?: CardDisplayRule[];
    depth?: number;
    characterName?: string;
};
export default function CardHtmlPreview(props: Props): import("react").JSX.Element;
export default function CardHtmlPreview(..._args: unknown[]): import('react').JSX.Element { return null as unknown as import('react').JSX.Element }

export {};
