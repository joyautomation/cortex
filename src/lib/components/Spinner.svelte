<script lang="ts">
	let { size = 20, color = 'var(--white)' } = $props();
</script>

<div class="spinner" style:width={`${size}px`} style:border-top={`3px solid ${color}`}></div>

<style>
	.spinner {
		aspect-ratio: 1;
		border: 3px solid rgba(0, 0, 0, 0.2);
		border-radius: 50%;
		animation: spin 1s linear infinite;
	}

	@keyframes spin {
		from {
			transform: rotate(0deg);
		}
		to {
			transform: rotate(360deg);
		}
	}
</style>
