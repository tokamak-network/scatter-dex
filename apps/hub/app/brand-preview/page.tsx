/* Internal brand preview page — pick a wordmark style. Not linked
 * from anywhere; reach via /brand-preview. */
import * as React from "react";

const VIEWBOX_W = 36;
const VIEWBOX_H = 24;
const HEIGHT = 38;
const SYMBOL_OPACITY = 0.7;
const ZK_TEXT_Y = "32%";
const ZK_FONT_SIZE = 13;
const ZK_LETTER_SPACING = -0.5;

function Logo() {
  const width = (HEIGHT * VIEWBOX_W) / VIEWBOX_H;
  return (
    <svg
      width={width}
      height={HEIGHT}
      viewBox={`0 0 ${VIEWBOX_W} ${VIEWBOX_H}`}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <g fill="currentColor" opacity={SYMBOL_OPACITY}>
        <path d="M0.551196 8.60858C0.440796 8.95898 0.304797 9.4318 0.216797 9.7902C0.277608 9.54236 0.390929 9.31046 0.549097 9.1102C0.707264 8.90993 0.906588 8.74596 1.13359 8.62939C1.5799 8.05462 2.15209 7.58987 2.80615 7.27089C3.46021 6.9519 4.1787 6.78719 4.9064 6.7894V6.7758C2.1968 5.9974 1.356 6.8886 1.1208 7.3078C0.898239 7.72513 0.708081 8.15892 0.552002 8.60539" />
        <path d="M3.35917 4.44479L2.95917 4.82719C3.41757 4.45119 4.17356 4.53839 5.33756 5.10319C5.58991 4.65111 5.91018 4.24046 6.28717 3.88559C5.73517 3.48559 5.17596 3.1328 4.82076 3.2976C4.30557 3.64361 3.81651 4.02704 3.35756 4.44479" />
        <path d="M8.9288 1.30791C8.5152 1.45991 7.96398 1.6631 7.55438 1.8303C7.76881 2.05788 7.96141 2.3051 8.1296 2.5687C8.74655 2.23423 9.38846 1.94804 10.0496 1.7127C9.9384 1.2503 9.9112 1.01909 10.0496 0.960693C9.7112 1.06389 9.25838 1.19111 8.92318 1.30791" />
        <path d="M15.6479 0.0439941C15.0183 0.0951941 14.18 0.173592 13.552 0.247192C13.224 0.327192 13.0791 0.44559 12.9167 0.93999C13.7727 0.777434 14.637 0.662079 15.5056 0.594409C15.6337 0.414309 15.8023 0.266722 15.9978 0.163501C16.1932 0.0602801 16.4101 0.00428694 16.6312 0L15.6479 0.0439941Z" />
        <path d="M22.6407 0.423275C22.0519 0.333675 21.2663 0.221683 20.6751 0.152083C20.0839 0.0818689 19.4869 0.223602 18.9904 0.552083C19.8926 0.598769 20.7917 0.693305 21.684 0.835286C22.3503 0.548151 23.0915 0.483335 23.7976 0.650472C23.4504 0.581672 22.9895 0.480875 22.6407 0.423275Z" />
        <path d="M28.9504 2.41689C28.5136 2.21449 27.9303 1.94889 27.4871 1.76489C26.6147 1.40326 25.6507 1.32462 24.7311 1.54008C25.4507 1.76233 26.1544 2.03282 26.8375 2.3497C28.0433 2.20302 29.262 2.48813 30.2776 3.15449C29.8816 2.92649 29.3551 2.61769 28.9479 2.41689" />
        <path d="M35.2112 8.97527C34.9163 8.13179 34.5097 7.33161 34.0024 6.59607L33.6904 6.16648C33.1547 5.4014 32.4474 4.77236 31.625 4.32976C30.8026 3.88716 29.8879 3.6433 28.9543 3.61768C29.4046 3.95977 29.8102 4.357 30.1615 4.80007C33.3447 5.25047 35.536 8.04886 35.7432 11.9297C35.7169 10.9236 35.5375 9.92733 35.2112 8.97527Z" />
        <path d="M30.6616 20.8657C31.2703 20.4714 31.847 20.0298 32.3864 19.5449C32.5896 19.3473 32.8664 19.0865 33.0576 18.8793C37.028 14.2785 35.224 7.6393 30.9608 6.4353C31.0067 6.64564 31.0313 6.86004 31.0344 7.07529C31.0344 7.11369 31.0344 7.1553 31.0344 7.1897C31.0301 7.40069 31.0052 7.61076 30.96 7.81689C35.52 9.87529 35.0728 18.0897 30.2336 21.1337L30.6616 20.8689" />
        <path d="M24.6984 23.2848C25.292 23.1312 26.0808 22.9112 26.6696 22.7312C32.5096 20.5368 33.4383 11.5776 30.1615 9.42236C29.8099 9.8541 29.4045 10.2391 28.9552 10.568C31.7272 13.6248 28.8864 22.2608 23.684 23.5008L24.6984 23.2848Z" />
        <path d="M17.9048 24.0001C18.4552 23.9953 19.1896 23.9873 19.74 23.9657C24.5888 23.4649 28.04 14.5601 26.8392 11.7737C26.1553 12.0718 25.4514 12.322 24.7328 12.5225C24.7216 16.0841 19.9272 24.0425 16.4888 23.9529C16.9136 23.9681 17.48 23.9993 17.9048 24.0001Z" />
        <path d="M10.872 23.0825C11.4136 23.2129 12.1376 23.3801 12.6824 23.4913C14.7056 23.6401 19.8024 16.7713 21.6816 13.1409C20.7856 13.2566 19.884 13.3247 18.9808 13.3449C17.512 14.7705 13.6368 19.2545 12.8752 20.1393C10.9136 22.4161 10.1848 22.8481 9.91919 22.8097L10.872 23.0825Z" />
        <path d="M4.96156 20.5104C5.54898 20.9041 6.1615 21.259 6.79518 21.5728L6.84718 21.5984C6.95598 21.0192 11.7776 15.2592 15.5 13.1984C14.6319 13.1051 13.7696 12.9646 12.9168 12.7776C8.46956 14.4824 3.92957 19.6976 4.71117 20.3376L4.96156 20.5104Z" />
        <path d="M1.74322 17.3944C1.95362 17.6776 2.23762 18.0536 2.46322 18.3224C1.46162 16.796 5.68481 12.8432 10.0552 11.9224C9.3932 11.6674 8.75139 11.3628 8.13521 11.0112C4.11361 11.448 0.286417 14.2984 1.07362 16.2688C1.26642 16.6144 1.52483 17.0744 1.74723 17.3952" />
        <path d="M0.00159912 11.804C0.00159912 11.8688 0.00159912 11.9328 0.00159912 11.9968C0.0191991 12.3312 0.047204 12.776 0.081604 13.108C-0.026396 10.94 3.2656 9.53922 6.288 9.63842C5.9107 9.27247 5.59033 8.85206 5.33758 8.3912C2.78239 8.0632 1.3856 8.72242 0.663196 9.33202C0.243019 10.0892 0.015535 10.9382 0.000793457 11.804" />
      </g>
      <text
        x="50%"
        y={ZK_TEXT_Y}
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="ui-serif, Georgia, 'Times New Roman', serif"
        fontStyle="italic"
        fontWeight="700"
        fontSize={ZK_FONT_SIZE}
        fill="currentColor"
        letterSpacing={ZK_LETTER_SPACING}
      >
        zk
      </text>
    </svg>
  );
}

const VARIANTS: Array<{
  id: string;
  label: string;
  description: string;
  wordmark: React.CSSProperties;
  text?: string;
  gap?: string;
}> = [
  {
    id: "1",
    label: "1. Italic serif (현재)",
    description: "로고의 zk와 같은 폰트군. 우아하고 클래식한 통일감.",
    wordmark: {
      fontFamily: "ui-serif, Georgia, 'Times New Roman', serif",
      fontStyle: "italic",
      fontWeight: 700,
      fontSize: "1.5rem",
      letterSpacing: "-0.02em",
    },
    gap: "0.25rem",
  },
  {
    id: "2",
    label: "2. Italic serif uppercase 와이드",
    description: "에디토리얼·럭셔리 패션 브랜드 톤.",
    wordmark: {
      fontFamily: "ui-serif, Georgia, 'Times New Roman', serif",
      fontStyle: "italic",
      fontWeight: 600,
      fontSize: "1.05rem",
      letterSpacing: "0.18em",
      textTransform: "uppercase",
    },
    text: "Scatter",
    gap: "0.5rem",
  },
  {
    id: "3",
    label: "3. Regular serif (non-italic)",
    description: "로고는 italic, 워드마크는 정자 → 콘트라스트.",
    wordmark: {
      fontFamily: "ui-serif, Georgia, 'Times New Roman', serif",
      fontWeight: 700,
      fontSize: "1.5rem",
      letterSpacing: "-0.015em",
    },
    gap: "0.25rem",
  },
  {
    id: "4",
    label: "4. Inter sans, 미디엄 + 타이트",
    description: "현재 본문 폰트 활용. 가장 미니멀.",
    wordmark: {
      fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
      fontWeight: 600,
      fontSize: "1.25rem",
      letterSpacing: "-0.04em",
    },
    gap: "0.35rem",
  },
  {
    id: "5",
    label: "5. Inter sans, light + 와이드",
    description: "가벼운 굵기로 우아함. 미니멀 디자인 톤.",
    wordmark: {
      fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
      fontWeight: 300,
      fontSize: "1.4rem",
      letterSpacing: "0.02em",
    },
    gap: "0.4rem",
  },
  {
    id: "6",
    label: "6. Inter uppercase 와이드 (geometric)",
    description: "기술감·web3 라벨 톤. 로고와 형태적 대조.",
    wordmark: {
      fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
      fontWeight: 700,
      fontSize: "0.95rem",
      letterSpacing: "0.22em",
      textTransform: "uppercase",
    },
    text: "Scatter",
    gap: "0.5rem",
  },
  {
    id: "7",
    label: "7. 모노스페이스",
    description: "코드/터미널 톤. 개발자 친화적.",
    wordmark: {
      fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace",
      fontWeight: 600,
      fontSize: "1.15rem",
      letterSpacing: "-0.04em",
    },
    gap: "0.4rem",
  },
  {
    id: "8",
    label: "8. Italic serif + smallcaps lookalike",
    description: "italic + 크기 작게 + 와이드 트래킹. 고급스러운 sub-mark.",
    wordmark: {
      fontFamily: "ui-serif, Georgia, 'Times New Roman', serif",
      fontStyle: "italic",
      fontWeight: 600,
      fontSize: "0.85rem",
      letterSpacing: "0.3em",
      textTransform: "uppercase",
    },
    text: "Scatter",
    gap: "0.55rem",
  },
];

export default function BrandPreviewPage() {
  return (
    <div style={{ padding: "3rem 2rem", color: "var(--color-primary)" }}>
      <h1
        style={{
          fontSize: "2rem",
          fontWeight: 700,
          marginBottom: "0.5rem",
          color: "var(--color-text)",
        }}
      >
        Brand wordmark variants
      </h1>
      <p
        style={{
          color: "var(--color-text-muted)",
          marginBottom: "2.5rem",
          fontSize: "0.9rem",
        }}
      >
        같은 로고 SVG에 워드마크 폰트 8가지 적용. 마음에 드는 번호 알려주시면 바로 hub/pro/docs 적용합니다.
      </p>
      <div
        style={{
          display: "grid",
          gap: "1.5rem",
          gridTemplateColumns: "1fr",
          maxWidth: "640px",
        }}
      >
        {VARIANTS.map((v) => (
          <div
            key={v.id}
            style={{
              border: "1px solid var(--color-border)",
              borderRadius: "0.75rem",
              padding: "1.5rem",
              background: "var(--color-surface)",
            }}
          >
            <div
              style={{
                display: "inline-flex",
                alignItems: "baseline",
                gap: v.gap ?? "0.25rem",
                color: "var(--color-primary)",
                lineHeight: 1,
              }}
            >
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  alignSelf: "center",
                }}
              >
                <Logo />
              </span>
              <span style={v.wordmark}>{v.text ?? "Scatter"}</span>
            </div>
            <div
              style={{
                marginTop: "1rem",
                fontSize: "0.85rem",
                color: "var(--color-text-muted)",
              }}
            >
              <strong style={{ color: "var(--color-text)" }}>{v.label}</strong>
              <div>{v.description}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
