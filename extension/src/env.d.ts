// Kỹ năng và prompt dựng sẵn được esbuild nhúng dưới dạng văn bản (xem esbuild.mjs → loader '.md').
declare module '*.md' {
  const content: string;
  export default content;
}

// Tệp CSS được esbuild gom vào bundle (import chỉ để lấy tác dụng phụ).
declare module '*.css';
