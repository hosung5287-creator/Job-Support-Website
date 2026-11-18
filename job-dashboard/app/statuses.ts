export const STATUSES = ['미지원', '지원함', '서류통과', '탈락'] as const;
export type Status = (typeof STATUSES)[number];
