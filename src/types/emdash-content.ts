import type {
	ContentBylineCredit,
	MediaValue,
	PortableTextBlock,
} from "emdash";

export interface PostData {
	id: string;
	title?: string;
	excerpt?: string;
	content?: PortableTextBlock[];
	featured_image?: MediaValue | string;
	publishedAt?: Date;
	updatedAt: Date;
	bylines?: ContentBylineCredit[];
}

export interface PageData {
	id: string;
	title?: string;
	content?: PortableTextBlock[];
	publishedAt?: Date;
	updatedAt: Date;
}

export interface EmDashEntry<TData> {
	id: string;
	data: TData;
	edit: Record<string, Record<string, unknown> | undefined>;
}