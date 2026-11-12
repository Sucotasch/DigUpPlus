#ifndef DIGUP_WIC_H
#define DIGUP_WIC_H

#include <stdint.h>
#include <wchar.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Decodes a picture through Windows Imaging Component, scaled so its long side is `max_pixel` where the codec can do
   it (JPEG: 1/2, 1/4, 1/8), and returns RGB in *pixels (3 bytes a pixel, stride = width * 3), freed with
   digup_wic_free. *width/*height are the decoded size; *source_width/*source_height the size the file stores (before
   scaling, before the camera's orientation, which the caller applies). Returns 0, or a nonzero code when WIC can't
   read the file (WebP, AVIF, RAW...), so the caller can fall back to stb. */
int32_t digup_wic_rgb(const wchar_t *path, uint32_t max_pixel, uint8_t **pixels,
                      int32_t *width, int32_t *height, int32_t *source_width, int32_t *source_height);

void digup_wic_free(void *pixels);

#ifdef __cplusplus
}
#endif

#endif
