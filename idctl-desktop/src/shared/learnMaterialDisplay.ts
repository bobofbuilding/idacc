type LearnProgressLike = {
  status?: string;
  note?: string;
  at?: number;
};

type LearnMaterialLike = {
  status?: string;
  processingTag?: string;
  progress?: LearnProgressLike[];
};

function cleanNote(note: unknown): string {
  return String(note || '').replace(/\s+/g, ' ').trim();
}

export function latestLearnFailureNote(material: LearnMaterialLike): string {
  const progress = Array.isArray(material.progress) ? material.progress : [];
  for (const item of progress.slice().reverse()) {
    if (item?.status !== 'failed') continue;
    const note = cleanNote(item.note);
    if (note) return note;
  }
  return material.status === 'failed' ? cleanNote(material.processingTag) : '';
}

