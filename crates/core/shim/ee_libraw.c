/* Small accessor layer over LibRaw's C API.
 *
 * libraw_data_t is a very large struct whose layout changes between releases,
 * so Rust never mirrors it. Everything the Rust side needs from it goes
 * through the flat functions below (scalars and borrowed C strings only).
 * Pointers returned here point into the handle and are valid until the handle
 * is recycled or closed.
 */
#include <stddef.h>
#include <string.h>
#include "libraw/libraw.h"

/* ---- decode configuration -------------------------------------------- */

/* Sets the output parameters for a linear camera-RGB decode:
 * unity white balance, no clipping/auto-brighten, linear 16-bit, no rotation
 * (Rust orients while resampling), `half_size` for a 2x2-binned fast path. */
void ee_configure_linear_decode(libraw_data_t *lr, int half_size)
{
  libraw_output_params_t *p = &lr->params;
  p->output_color = 0;
  p->output_bps = 16;
  p->gamm[0] = 1.0;
  p->gamm[1] = 1.0;
  p->no_auto_bright = 1;
  p->use_camera_wb = 0;
  p->use_auto_wb = 0;
  p->user_mul[0] = p->user_mul[1] = p->user_mul[2] = p->user_mul[3] = 1.0f;
  p->highlight = 0;
  /* Keep the white level fixed at the sensor maximum instead of letting
   * LibRaw lower it to the brightest pixel in this particular frame. */
  p->adjust_maximum_thr = 0.0f;
  p->user_flip = 0;
  p->half_size = half_size ? 1 : 0;
  p->user_qual = 3; /* AHD */
}

/* ---- identification --------------------------------------------------- */

const char *ee_make(libraw_data_t *lr) { return lr->idata.make; }
const char *ee_model(libraw_data_t *lr) { return lr->idata.model; }
const char *ee_normalized_make(libraw_data_t *lr) { return lr->idata.normalized_make; }
const char *ee_normalized_model(libraw_data_t *lr) { return lr->idata.normalized_model; }
const char *ee_lens_name(libraw_data_t *lr) { return lr->lens.Lens; }
const char *ee_makernotes_lens_name(libraw_data_t *lr) { return lr->lens.makernotes.Lens; }
float ee_min_focal(libraw_data_t *lr) { return lr->lens.MinFocal; }
float ee_max_focal(libraw_data_t *lr) { return lr->lens.MaxFocal; }
const char *ee_body_serial(libraw_data_t *lr) { return lr->shootinginfo.BodySerial; }
const char *ee_internal_body_serial(libraw_data_t *lr) { return lr->shootinginfo.InternalBodySerial; }

/* ---- exposure --------------------------------------------------------- */

float ee_iso(libraw_data_t *lr) { return lr->other.iso_speed; }
float ee_shutter(libraw_data_t *lr) { return lr->other.shutter; }
float ee_aperture(libraw_data_t *lr) { return lr->other.aperture; }
float ee_focal_length(libraw_data_t *lr) { return lr->other.focal_len; }
/* Seconds since the epoch of the camera's local wall-clock time as if it were
 * UTC (EXIF carries no time zone). 0 when unknown. */
long long ee_timestamp(libraw_data_t *lr) { return (long long)lr->other.timestamp; }

/* ---- geometry --------------------------------------------------------- */

int ee_raw_width(libraw_data_t *lr) { return lr->sizes.raw_width; }
int ee_raw_height(libraw_data_t *lr) { return lr->sizes.raw_height; }
int ee_image_width(libraw_data_t *lr) { return lr->sizes.width; }
int ee_image_height(libraw_data_t *lr) { return lr->sizes.height; }
/* LibRaw (dcraw) flip code: 0 none, 3 = 180, 5 = 90 ccw, 6 = 90 cw, bit 4 = transpose. */
int ee_flip(libraw_data_t *lr) { return lr->sizes.flip; }

/* ---- colour ----------------------------------------------------------- */

float ee_cam_mul(libraw_data_t *lr, int i) { return lr->color.cam_mul[i]; }
float ee_pre_mul(libraw_data_t *lr, int i) { return lr->color.pre_mul[i]; }
float ee_rgb_cam(libraw_data_t *lr, int row, int col) { return lr->color.rgb_cam[row][col]; }
float ee_cam_xyz(libraw_data_t *lr, int row, int col) { return lr->color.cam_xyz[row][col]; }
int ee_colors(libraw_data_t *lr) { return lr->idata.colors; }
unsigned ee_filters(libraw_data_t *lr) { return lr->idata.filters; }
unsigned ee_white_level(libraw_data_t *lr) { return lr->color.maximum; }

/* ---- embedded thumbnails ---------------------------------------------- */

int ee_thumb_count(libraw_data_t *lr) { return lr->thumbs_list.thumbcount; }
int ee_thumb_item_width(libraw_data_t *lr, int i) { return lr->thumbs_list.thumblist[i].twidth; }
int ee_thumb_item_height(libraw_data_t *lr, int i) { return lr->thumbs_list.thumblist[i].theight; }
/* 1 when the stored data is a JPEG stream. */
int ee_thumb_item_is_jpeg(libraw_data_t *lr, int i)
{
  return lr->thumbs_list.thumblist[i].tformat == LIBRAW_INTERNAL_THUMBNAIL_JPEG;
}

/* ---- processed images (from dcraw_make_mem_image / _thumb) ------------- */

int ee_image_type(const libraw_processed_image_t *p) { return (int)p->type; }
int ee_image_out_width(const libraw_processed_image_t *p) { return p->width; }
int ee_image_out_height(const libraw_processed_image_t *p) { return p->height; }
int ee_image_out_colors(const libraw_processed_image_t *p) { return p->colors; }
int ee_image_out_bits(const libraw_processed_image_t *p) { return p->bits; }
unsigned ee_image_out_size(const libraw_processed_image_t *p) { return p->data_size; }
const unsigned char *ee_image_out_data(const libraw_processed_image_t *p) { return p->data; }

/* LibRaw_image_formats values, exported so Rust does not hardcode them. */
int ee_image_type_jpeg(void) { return LIBRAW_IMAGE_JPEG; }
int ee_image_type_bitmap(void) { return LIBRAW_IMAGE_BITMAP; }
