#include <pebble.h>

#define XS_STACK_BYTES (4U * 1024U)
#define XS_SLOT_BYTES (32U * 1024U)
#define XS_CHUNK_BYTES (20U * 1024U)
#define XS_ARENA_TOTAL_BYTES \
  (XS_STACK_BYTES + XS_SLOT_BYTES + XS_CHUNK_BYTES)
#define XS_ARENA_BUDGET_BYTES (56U * 1024U)

#ifdef PBL_DEBUG
#define XS_CREATION_FLAGS \
  (kModdableCreationFlagDebug | kModdableCreationFlagLogInstrumentation)
#else
#define XS_CREATION_FLAGS 0U
#endif

#if (XS_STACK_BYTES == 0U) || (XS_SLOT_BYTES == 0U) || \
    (XS_CHUNK_BYTES == 0U)
#error "XS stack, slot, and chunk sizes must all be nonzero"
#endif

#if XS_ARENA_TOTAL_BYTES > XS_ARENA_BUDGET_BYTES
#error "XS arenas exceed the 56 KiB RAM budget"
#endif

int main(void) {
  Window *window = window_create();
  window_stack_push(window, true);

  ModdableCreationRecord creation = {
      .recordSize = sizeof(creation),
      .stack = XS_STACK_BYTES,
      .slot = XS_SLOT_BYTES,
      .chunk = XS_CHUNK_BYTES,
      .flags = XS_CREATION_FLAGS,
  };
  moddable_createMachine(&creation);

  window_destroy(window);
}
