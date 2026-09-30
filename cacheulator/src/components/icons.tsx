type IconProps = { size?: number; className?: string }

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
})

export const IconStepInto = ({ size = 14, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M3 3.5v9l5-4.5-5-4.5Z" />
    <path d="M11 3v9" />
  </svg>
)

export const IconStepOver = ({ size = 14, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M4 2.5v7l4-3.5-4-3.5Z" />
    <path d="M9 6h5" />
    <path d="M11.5 3.5 14 6l-2.5 2.5" />
  </svg>
)

export const IconStepOut = ({ size = 14, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M8 13.5v-7l-4 3.5 4 3.5Z" />
    <path d="M12 10h3" />
    <path d="M13.5 12.5 16 10l-2.5-2.5" />
  </svg>
)

export const IconPlay = ({ size = 14, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M4.5 3 13 8l-8.5 5V3Z" />
  </svg>
)

export const IconStop = ({ size = 14, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <rect x="4" y="4" width="8" height="8" rx="1.2" />
  </svg>
)

export const IconRestart = ({ size = 14, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M13 8a5 5 0 1 1-1.6-3.7" />
    <path d="M13.4 2.6V5.2h-2.6" />
  </svg>
)

export const IconReload = ({ size = 14, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M2.6 8a5.4 5.4 0 0 1 9.1-3.9" />
    <path d="M13.4 8a5.4 5.4 0 0 1-9.1 3.9" />
    <path d="M11.9 1.4v2.7H9.2" />
    <path d="M4.1 14.6v-2.7h2.7" />
  </svg>
)

export const IconChip = ({ size = 14, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <rect x="4.5" y="4.5" width="7" height="7" rx="1" />
    <path d="M6.5 1.5v3M9.5 1.5v3M6.5 11.5v3M9.5 11.5v3M1.5 6.5h3M1.5 9.5h3M11.5 6.5h3M11.5 9.5h3" />
  </svg>
)

export const IconGauge = ({ size = 14, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M2.5 12a6 6 0 1 1 11 0" />
    <path d="M8 12 10.8 7" />
  </svg>
)

export const IconTrash = ({ size = 14, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.6 9h6.8l.6-9" />
  </svg>
)

export const IconPlus = ({ size = 14, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M8 3v10M3 8h10" />
  </svg>
)
