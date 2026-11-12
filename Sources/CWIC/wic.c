/* Windows Imaging Component, wrapped small enough for one call: decode a picture scaled, as RGB. The point is JPEG:
   WIC decodes it at 1/2, 1/4 or 1/8 of its size instead of in full, which is what stb costs on every photo and on the
   look-alike fingerprints. COM lives here, not in Swift: the interfaces are vtable calls, and a header with COBJMACROS
   reads as plainly as this. */
#define COBJMACROS
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wincodec.h>
#include <stdlib.h>
#include <string.h>
#include "digup_wic.h"

/* COM once a thread: WIC's factory and decoders are apartment objects. Never uninitialized (the helpers live as long
   as the app, and an unbalanced uninit is worse than none); an apartment someone else set up is fine to use too. */
static int wic_ready(void) {
    static __declspec(thread) int status = -1;
    if (status == -1) {
        HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
        status = (SUCCEEDED(hr) || hr == RPC_E_CHANGED_MODE) ? 1 : 0;
    }
    return status;
}


/* WIC's 24-bit format is BGR; the caller wants RGB, so the two outer bytes of every pixel trade places. */
static void swap_red_blue(uint8_t *pixels, UINT width, UINT height, UINT stride) {
    for (UINT y = 0; y < height; y++) {
        uint8_t *row = pixels + (size_t)y * stride;
        for (UINT x = 0; x < width; x++) {
            uint8_t value = row[x * 3];
            row[x * 3] = row[x * 3 + 2];
            row[x * 3 + 2] = value;
        }
    }
}

int32_t digup_wic_rgb(const wchar_t *path, uint32_t max_pixel, uint8_t **pixels,
                      int32_t *width, int32_t *height, int32_t *source_width, int32_t *source_height) {
    IWICImagingFactory *factory = NULL;
    IWICBitmapDecoder *decoder = NULL;
    IWICBitmapFrameDecode *frame = NULL;
    IWICBitmapSourceTransform *transform = NULL;
    uint8_t *buffer = NULL;
    UINT outWidth = 0, outHeight = 0;
    HRESULT hr;
    if (!pixels || !width || !height || !source_width || !source_height) return 1;
    if (!wic_ready()) return 2;
    hr = CoCreateInstance(&CLSID_WICImagingFactory, NULL, CLSCTX_INPROC_SERVER, &IID_IWICImagingFactory,
                          (void **)&factory);
    if (FAILED(hr)) return 3;
    hr = IWICImagingFactory_CreateDecoderFromFilename(factory, path, NULL, GENERIC_READ,
                                                      WICDecodeMetadataCacheOnDemand, &decoder);
    if (FAILED(hr)) { IWICImagingFactory_Release(factory); return 4; }
    hr = IWICBitmapDecoder_GetFrame(decoder, 0, &frame);
    if (FAILED(hr)) { IWICBitmapDecoder_Release(decoder); IWICImagingFactory_Release(factory); return 5; }
    UINT sourceW = 0, sourceH = 0;
    hr = IWICBitmapFrameDecode_GetSize(frame, &sourceW, &sourceH);
    if (FAILED(hr) || sourceW < 1 || sourceH < 1) {
        IWICBitmapFrameDecode_Release(frame);
        IWICBitmapDecoder_Release(decoder);
        IWICImagingFactory_Release(factory);
        return 6;
    }
    /* Where the codec can scale while decoding (JPEG: 1/2, 1/4, 1/8) it does; a format that can't (PNG) returns its
       own size through the transform or not at all, and the caller resizes as it always did. */
    UINT targetW = sourceW, targetH = sourceH;
    if (max_pixel > 0 && (sourceW > max_pixel || sourceH > max_pixel)) {
        if (sourceW >= sourceH) {
            targetW = max_pixel;
            targetH = (UINT)((uint64_t)sourceH * max_pixel / sourceW);
        } else {
            targetH = max_pixel;
            targetW = (UINT)((uint64_t)sourceW * max_pixel / sourceH);
        }
        if (targetW < 1) targetW = 1;
        if (targetH < 1) targetH = 1;
    }
    hr = IWICBitmapFrameDecode_QueryInterface(frame, &IID_IWICBitmapSourceTransform, (void **)&transform);
    if (SUCCEEDED(hr) && max_pixel > 0) {
        IWICBitmapSourceTransform_GetClosestSize(transform, &targetW, &targetH);
        WICPixelFormatGUID format = GUID_WICPixelFormat24bppBGR;
        IWICBitmapSourceTransform_GetClosestPixelFormat(transform, &format);
        const WICPixelFormatGUID wanted = GUID_WICPixelFormat24bppBGR;
        if (memcmp(&format, &wanted, sizeof(GUID)) == 0) {
            UINT stride = (targetW * 3 + 3) & ~3u;
            UINT size = stride * targetH;
            buffer = (uint8_t *)malloc(size);
            if (buffer) {
                HRESULT copied = IWICBitmapSourceTransform_CopyPixels(transform, NULL, targetW, targetH, &format,
                                                                      WICBitmapTransformRotate0, stride, size,
                                                                      buffer);
                if (SUCCEEDED(copied)) { outWidth = targetW; outHeight = targetH; }
                else { free(buffer); buffer = NULL; }
            }
        }
    }
    if (transform) { IWICBitmapSourceTransform_Release(transform); transform = NULL; }
    if (!buffer) {
        /* No scaled decode here: the frame at its own size, converted to the RGB the caller expects. */
        outWidth = sourceW;
        outHeight = sourceH;
        UINT stride = (outWidth * 3 + 3) & ~3u;
        UINT size = stride * outHeight;
        buffer = (uint8_t *)malloc(size);
        if (buffer) {
            IWICFormatConverter *converter = NULL;
            hr = IWICImagingFactory_CreateFormatConverter(factory, &converter);
            if (SUCCEEDED(hr)) {
                hr = IWICFormatConverter_Initialize(converter, (IWICBitmapSource *)frame, &GUID_WICPixelFormat24bppBGR,
                                                    WICBitmapDitherTypeNone, NULL, 0.0, WICBitmapPaletteTypeCustom);
            }
            if (SUCCEEDED(hr)) {
                hr = IWICFormatConverter_CopyPixels(converter, NULL, stride, size, buffer);
            }
            if (converter) IWICFormatConverter_Release(converter);
            if (FAILED(hr)) { free(buffer); buffer = NULL; }
        }
    }
    IWICBitmapFrameDecode_Release(frame);
    IWICBitmapDecoder_Release(decoder);
    IWICImagingFactory_Release(factory);
    if (!buffer) return 8;
    swap_red_blue(buffer, outWidth, outHeight, (outWidth * 3 + 3) & ~3u);
    *pixels = buffer;
    *width = (int32_t)outWidth;
    *height = (int32_t)outHeight;
    *source_width = (int32_t)sourceW;
    *source_height = (int32_t)sourceH;
    return 0;
}

void digup_wic_free(void *pixels) {
    free(pixels);
}
